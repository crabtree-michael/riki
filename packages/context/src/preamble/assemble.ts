/**
 * Tier 1 assembly — §4.1, §4.3, §4.4.
 *
 * Called once, on `match_started`, before the session opens, and then frozen for the match: it is
 * the cached prefix, and a change rewrites it (ADR-0011).
 *
 * Two properties are the whole contract, and both are asserted by test:
 *
 * - **Total.** An enrichment failure is recorded in `degraded`, never thrown. A preamble that fails
 *   is a match with no coach, and a coach with no matchup notes is still a coach. Every `catch` and
 *   every deadline path below lands in the same place: a section that is absent from the text and
 *   present in telemetry.
 * - **Pure in its input.** `assemble()` produces byte-identical text for identical input, because a
 *   reconnect (§7.5) re-assembles it and a new session that cannot cache the prefix it already paid
 *   for has thrown away the reason Tier 1 exists. Nothing here reads a clock or a global; the one
 *   timing-dependent thing — which enrichment arrived — is deliberately the only thing that can
 *   vary, and it varies into `degraded` rather than into a reordering.
 *
 * The deadline is short *(tunable: 3,000 ms, concurrent with the draft)* and it is a **race, not a
 * timeout**: a port that never resolves still produces a preamble, because the losing side of the
 * race is simply not read.
 */

import type { MonoMs } from '../common/types.js';
import type { ReferenceDataPort, BuildBenchmark, MatchupNote } from '../common/ports.js';
import type { Timers } from '../common/timers.js';
import type { PreambleAssembler, EnrichmentPlanner } from './contracts.js';
import type { Preamble, PreambleInput, PreambleSection, PreambleSectionId } from './types.js';
import type { Enrichment, PreambleSectionSource } from './sections/index.js';
import { systemTimers } from '../common/timers.js';
import { estimateTokens } from '../render/tokens.js';
import { ALL_PREAMBLE_SECTIONS } from './sections/index.js';
import { createEnrichmentPlanner } from './enrichment.js';

/** §4.3. Concurrent with the draft, which is ~90 s, so this is not the thing making anyone wait. */
export const DEFAULT_ENRICHMENT_DEADLINE_MS = 3_000;

export interface PreambleAssemblerOptions {
  readonly reference: ReferenceDataPort;
  readonly planner?: EnrichmentPlanner;
  readonly sections?: readonly PreambleSectionSource[];
  readonly timers?: Timers;
  /** REPO_SKELETON §11.5 is open about where this lives; it is injected either way (§4.2). */
  readonly persona?: string;
  readonly enrichmentDeadlineMs?: number;
}

/** Sections whose absence is a *degradation* rather than a choice — the ones that need a port. */
const ENRICHED: ReadonlySet<PreambleSectionId> = new Set(['matchups', 'benchmarks'] as const);

export function createPreambleAssembler(options: PreambleAssemblerOptions): PreambleAssembler {
  const planner = options.planner ?? createEnrichmentPlanner();
  const sources = options.sections ?? ALL_PREAMBLE_SECTIONS;
  const timers = options.timers ?? systemTimers;
  const deadlineMs = options.enrichmentDeadlineMs ?? DEFAULT_ENRICHMENT_DEADLINE_MS;
  const persona = options.persona ?? null;

  return {
    async assemble(input: PreambleInput, deadline: MonoMs): Promise<Preamble> {
      const enrichment = await gather(
        options.reference,
        planner.plan(input.draft, input.player),
        timers,
        deadlineMs,
      );

      const sections: PreambleSection[] = [];
      const degraded: PreambleSectionId[] = [];

      for (const source of sources) {
        const built = source.build(input, enrichment, persona);
        if (built === null) {
          // Only a section that *wanted* a port and did not get one is degraded. A player with no
          // durable memory has an absent `history` section and a perfectly healthy preamble.
          if (ENRICHED.has(source.id)) degraded.push(source.id);
          continue;
        }
        sections.push(built);
      }

      const text = sections.map((s) => s.text).join('\n');
      return {
        text,
        tokens: estimateTokens(text),
        frozenAt: deadline,
        sections,
        degraded,
      };
    },
  };
}

/**
 * Fires every planned request at once and reads whatever has landed when the deadline fires.
 *
 * A race rather than a per-request timeout: `Promise.race` against one timer means a port that
 * never resolves costs nothing beyond the deadline, and a port that *rejects* is caught into a
 * miss rather than taking the whole preamble with it.
 */
async function gather(
  reference: ReferenceDataPort,
  requests: readonly ReturnType<EnrichmentPlanner['plan']>[number][],
  timers: Timers,
  deadlineMs: number,
): Promise<Enrichment> {
  const matchups = new Map<string, MatchupNote>();
  let benchmark: BuildBenchmark | null = null;

  const inFlight = requests.map(async (request) => {
    switch (request.want) {
      case 'benchmark': {
        const outcome = await reference.benchmark(request.hero, request.at).catch(() => null);
        if (outcome?.ok === true) benchmark = outcome.value;
        return;
      }
      case 'matchup': {
        const outcome = await reference.matchup(request.a, request.b).catch(() => null);
        if (outcome?.ok === true) matchups.set(String(request.b), outcome.value);
        return;
      }
      case 'patch_notes':
        // No `ReferenceDataPort` method today — see `sections/index.ts`. Planned, so that adding
        // one later is a case here rather than a change to the planner and the section too.
        return;
    }
  });

  let cancel: (() => void) | undefined;
  await Promise.race([
    Promise.allSettled(inFlight),
    new Promise<void>((resolve) => {
      cancel = timers.after(deadlineMs, resolve);
    }),
  ]);
  // Cancelling the loser matters under a manual clock: a timer left pending fires into a test that
  // has already moved on, which reads as a flake in whatever comes next.
  cancel?.();

  return { matchups, benchmark };
}

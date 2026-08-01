/**
 * The one thing this package exports at runtime.
 *
 * Three tiers of context and four spans of memory meet here, and the reason they meet in one object
 * is that they share two budgets: the 16,384-token cached prefix (Tier 1 + the Tier 3 manifest,
 * §4.2) and the ~28,672-token conversation window (Tier 2 + Tier 3 results + the conversation,
 * §7.1). Nobody can enforce a ceiling on a resource they can only see a third of.
 *
 * One turn, end to end (§9.2):
 *
 * ```
 *   events decides to speak ──► openTurn(brief)
 *          snapshot rendered ──► ledger.append({kind:'snapshot'}) ──► handed to the session
 *          agent speaks, may issue commands ──► ledger.append()
 *                                  closeTurn() ──► Compactor.consider() ──► WindowPlan | null
 * ```
 *
 * The compaction check is at turn **close**, never at turn open. At open it would add latency to
 * the path the 5 ms and 100 ms budgets protect; at close there is nobody waiting.
 *
 * What this file deliberately does not do: decide whether to speak (`packages/events`), truncate
 * anything (`packages/realtime` executes the plan it is handed), fuse or age a fact
 * (`packages/world-model`), or summarise with a model (§7.4). Each is a non-goal in §1.2 with an
 * argument attached.
 *
 * See docs/design/context-and-memory-architecture.md §9.4.
 */

import type { GameClock, MatchId, MonoMs, PrivacyPolicy, TurnId } from './common/types.js';
import type { ContextTelemetry, WorldModelReader } from './common/ports.js';
import type { Budget, RenderedText, TokenCounter } from './render/types.js';
import type { Preamble, PreambleInput, PrefixBudget } from './preamble/types.js';
import type { RenderedSnapshot, TurnBrief } from './snapshot/types.js';
import type { LedgerRef, TurnOutcome, WindowBudget, WindowPlan } from './memory/types.js';
import type {
  CoachingMemory,
  ConversationLedgerWriter,
  CoachingMemoryReader,
  PlayerMemoryStore,
} from './memory/contracts.js';
import type { EventTapeReader } from './memory/ports.js';
import type { ToolManifest } from './tools/contracts.js';
import type { MatchLedger } from './memory/ledger.js';
import type { MutableWorkingMemory } from './memory/working.js';
import type { PreambleAssembler } from './preamble/contracts.js';
import type { SnapshotRenderer } from './snapshot/contracts.js';
import { createTokenCounter } from './render/tokens.js';
import { DEFAULT_PRIVACY } from './render/privacy.js';
import { createConversationLedger } from './memory/ledger.js';
import { createCoachingMemory } from './memory/coaching.js';
import { createWorkingMemory } from './memory/working.js';
import { createRetentionPolicy, DEFAULT_WINDOW_BUDGET } from './memory/retention.js';
import { createSummaryRenderer } from './memory/summary.js';
import { createCompactor } from './memory/compactor.js';
import { createRehydrator } from './memory/rehydrate.js';
import { createSnapshotRenderer } from './snapshot/renderer.js';
import { createPrefixBudget } from './preamble/budget.js';

/** What the session is opened with. Frozen for the match (§4.4, ADR-0011). */
export interface SessionContext {
  readonly preamble: Preamble;
  readonly manifest: ToolManifest;
  /** The sum nobody was computing: persona + preamble + manifest against the 16,384 cap (§4.2). */
  readonly prefix: PrefixBudget;
}

export interface TurnContext {
  readonly turnId: TurnId;
  readonly snapshot: RenderedSnapshot;
  /** What is left for command results this turn, after the snapshot (§7.1). */
  readonly remaining: Budget;
}

export interface ContextAssembler {
  /** Tier 1. Called once per match, before the session opens. */
  openSession(input: PreambleInput, deadline: MonoMs): Promise<SessionContext>;

  /** Tier 2. Synchronous and budgeted under 5 ms — this is the hot path (§5.4). */
  openTurn(brief: TurnBrief, now: MonoMs): TurnContext;

  /**
   * Where compaction is considered (§9.2). At turn *open* it would add latency to the path the
   * 5 ms and 100 ms budgets protect; at close there is nobody waiting.
   */
  closeTurn(turnId: TurnId, outcome: TurnOutcome, now: MonoMs): void;

  /** For `packages/events`. Read-only, and the only edge between the two packages (§9.3). */
  readonly coaching: CoachingMemoryReader;

  /** For the session adapter in the composition root: transcripts and command results in. */
  readonly ledger: ConversationLedgerWriter;

  /** After a lost session (§7.5). The preamble is re-assembled separately, byte-identically. */
  rehydrate(now: MonoMs): Promise<RenderedText>;
}

// -----------------------------------------------------------------------------------------------
// The implementation
// -----------------------------------------------------------------------------------------------

export interface ContextAssemblerDeps {
  readonly matchId: MatchId;
  readonly world: WorldModelReader;
  readonly preamble: PreambleAssembler;
  /** From `tools/`'s `buildToolSurface()`, assembled by the same composition root (§9.4). */
  readonly manifest: ToolManifest;
  /** `packages/events` implements this; the composition root wires it (§8.2). */
  readonly tape?: EventTapeReader;
  readonly durable?: PlayerMemoryStore;
  readonly telemetry?: ContextTelemetry;
  readonly counter?: TokenCounter;
  readonly renderer?: SnapshotRenderer;
  readonly windowBudget?: WindowBudget;
  /** From `packages/config`, injected. This package never reads `process.env`. */
  readonly privacy?: PrivacyPolicy;
  /** §4.2's persona allocation, counted whether or not the text has found its home yet. */
  readonly personaTokens?: number;
  /** Snapshot ceiling per turn *(tunable: 400, dota2 §6.2's upper bound)*. */
  readonly snapshotTokens?: number;
  /** What is left for command results after the snapshot *(tunable: 600, tools §8.2)*. */
  readonly turnResultTokens?: number;
  /** Elision is off; §5.3 is the argument. Present so the switch has one place to live. */
  readonly elision?: boolean;
  /** Where a plan goes when the compactor produces one. `packages/realtime` executes it (§8.4). */
  readonly onWindowPlan?: (plan: WindowPlan) => void;
}

const DEFAULT_SNAPSHOT_TOKENS = 400;
const DEFAULT_TURN_RESULT_TOKENS = 600;
const DEFAULT_TAPE_EVENTS = 5;

/** What the assembler exposes beyond the declared contract, for the composition root's own wiring. */
export interface RikiContext extends ContextAssembler {
  readonly ledgerRecord: MatchLedger;
  readonly coachingMemory: CoachingMemory;
  readonly working: MutableWorkingMemory;
  /** Called once `packages/realtime` confirms a plan it was handed (§8.4, §7.6). */
  applyWindowPlan(plan: WindowPlan, dropped: readonly LedgerRef[]): void;
  /** Reconciliation (§7.6): a non-zero `api_truncation` count is a bug, not a condition. */
  noteDropped(refs: readonly LedgerRef[], reason: 'api_truncation' | 'session_lost'): void;
}

export function createContextAssembler(deps: ContextAssemblerDeps): RikiContext {
  const counter = deps.counter ?? createTokenCounter();
  const privacy = deps.privacy ?? DEFAULT_PRIVACY;
  const snapshotTokens = deps.snapshotTokens ?? DEFAULT_SNAPSHOT_TOKENS;
  const turnResultTokens = deps.turnResultTokens ?? DEFAULT_TURN_RESULT_TOKENS;
  const windowBudget = deps.windowBudget ?? DEFAULT_WINDOW_BUDGET;

  const ledger = createConversationLedger(deps.matchId);
  const coaching = createCoachingMemory(ledger);
  const working = createWorkingMemory(ledger, coaching, counter, {
    elision: deps.elision ?? false,
  });
  const renderer = deps.renderer ?? createSnapshotRenderer();
  const summary = createSummaryRenderer();
  const retention = createRetentionPolicy({
    counter,
    summarise: (entries) =>
      summary.render(entries, deps.world, { maxTokens: snapshotTokens, spentTokens: 0 }),
  });
  const compactor = createCompactor({
    ledger,
    working,
    retention,
    budget: windowBudget,
    ...(deps.onWindowPlan === undefined ? {} : { onPlan: deps.onWindowPlan }),
  });
  const rehydrator = createRehydrator({ summary });

  /** The clock of the turn currently open, so a ledger entry can carry game time (§6.3). */
  const clockOfTurn = new Map<TurnId, GameClock | null>();

  return {
    async openSession(input: PreambleInput, deadline: MonoMs) {
      const preamble = await deps.preamble.assemble(input, deadline);

      // §4.2's sum, in the one place that can see all three claimants. `check()` fails a test, not
      // a match: every number here is knowable before a session exists.
      const parts = new Map<string, number>([
        ['persona', deps.personaTokens ?? 0],
        ...preamble.sections.map((s): [string, number] => [`preamble.${s.id}`, s.tokens]),
        ['manifest', deps.manifest.estimatedTokens],
      ]);
      const prefix = createPrefixBudget(parts);
      deps.telemetry?.noteRender('preamble', 0, preamble.tokens);

      return { preamble, manifest: deps.manifest, prefix };
    },

    openTurn(brief: TurnBrief, now: MonoMs) {
      const started = now;
      const world = deps.world.snapshot(now);

      ledger.append({
        kind: 'turn_opened',
        turnId: brief.turnId,
        cause: brief.cause,
        at: now,
        clock: world.clock,
      });
      clockOfTurn.set(brief.turnId, world.clock);

      const snapshot = renderer.render(world, {
        turnId: brief.turnId,
        now,
        cause: brief.cause,
        budget: { maxTokens: snapshotTokens, spentTokens: 0 },
        privacy,
        tape: deps.tape?.recent(DEFAULT_TAPE_EVENTS, null) ?? [],
        elisionBase: working.elisionBase(),
      });

      const ref = ledger.append({
        kind: 'snapshot',
        turnId: brief.turnId,
        rendered: { text: snapshot.text, tokens: snapshot.tokens },
        sections: snapshot.sections.map((s) => s.id),
        at: now,
      });
      working.recordSnapshot(snapshot, ref, world.clock);

      deps.telemetry?.noteRender('snapshot', now - started, snapshot.tokens);
      if (snapshot.omitted.length > 0) {
        deps.telemetry?.noteTruncation('snapshot', snapshot.omitted.map(String));
      }

      return {
        turnId: brief.turnId,
        snapshot,
        remaining: { maxTokens: turnResultTokens, spentTokens: 0 },
      };
    },

    closeTurn(turnId: TurnId, outcome: TurnOutcome, now: MonoMs) {
      ledger.append({ kind: 'turn_closed', turnId, outcome, at: now });
      working.noteTurnClosed(turnId, outcome);
      clockOfTurn.delete(turnId);

      // The only place a compaction is considered. Cheap, and usually null.
      const plan = compactor.consider(deps.world.snapshot(now), now);
      if (plan !== null) {
        deps.telemetry?.noteCompaction(
          plan.reason,
          working.window().estimatedTokens - plan.estimatedTokensAfter,
          plan.estimatedTokensAfter,
        );
      }
    },

    coaching: coaching satisfies CoachingMemoryReader,

    ledger: {
      append: (entry) => ledger.append(entry),
      markDropped: (refs, reason) => {
        ledger.markDropped(refs, reason);
      },
    } satisfies ConversationLedgerWriter,

    rehydrate(now: MonoMs): Promise<RenderedText> {
      return Promise.resolve(
        rehydrator.brief(ledger, deps.world.snapshot(now), {
          maxTokens: snapshotTokens * 2,
          spentTokens: 0,
        }),
      );
    },

    ledgerRecord: ledger,
    coachingMemory: coaching,
    working,

    applyWindowPlan(plan: WindowPlan, dropped: readonly LedgerRef[]): void {
      compactor.applied(plan, dropped);
    },

    noteDropped(refs, reason): void {
      ledger.markDropped(refs, reason);
      const usage = working.window().estimatedTokens;
      // §7.6: an API-initiated truncation means our low-water mark or our counter is wrong. It is a
      // bug, not a condition, and it should read like one in telemetry.
      if (reason === 'api_truncation')
        deps.telemetry?.noteWindowDrift(usage, windowBudget.capTokens);
    },
  };
}

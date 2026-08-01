/**
 * Fusion — the keystone.
 *
 * No `this`, no clock, no I/O, no allocation the caller cannot see. A fusion test is: construct a
 * state, apply an observation, assert the next state. Milliseconds, no fixtures, no listener.
 *
 * This purity is ADR-0014 and it is the constraint most likely to be eroded by a convenient
 * shortcut. If the reducer ever needs the time, it takes it as a parameter; if it ever needs to
 * fetch something, the design is wrong and the fetch belongs in the composition root.
 *
 * See docs/design/state-capture-architecture.md §5.2.
 */

import type { Timestamps } from '../fact.js';
import { apiFact } from '../fact.js';
import type { Observation } from '../observation.js';
import type { ChatLine, FieldPath, HeroId, WorldState } from '../state.js';
import { fieldPath, readFact, writeFact } from '../state.js';
import type { MonoMs } from '../time.js';
import type { Candidate } from './candidate.js';
import { asRecord, readString } from './candidate.js';
import type { ConfidenceGate } from './confidence.js';
import type { PrecedencePolicy } from './precedence.js';
import { clockOf, readGsiPayload } from './read-gsi.js';
import { readCvDetections } from './read-cv.js';
import { readLogEvent } from './read-log.js';
import type { StalenessPolicy } from './staleness.js';

export interface FusionPolicies {
  readonly precedence: PrecedencePolicy;
  readonly confidence: ConfidenceGate;
  readonly staleness: StalenessPolicy;
}

/**
 * Kept for telemetry. "CV facts stopped landing three patches ago" is exactly the kind of failure
 * that presents as *nothing*, and a counter is the cheapest possible detector for it.
 */
export interface RejectionReason {
  readonly field: FieldPath;
  readonly why:
    'lower_rank' | 'gsi_shadow' | 'older' | 'lower_confidence' | 'below_threshold' | 'unparsed';
}

export interface FusionOutcome {
  /** Referentially identical to the input state when nothing changed — cheap to test for. */
  readonly state: WorldState;
  readonly rejections: readonly RejectionReason[];
  /**
   * How many candidates landed. Not in the architecture's §5.2 shape; `ApplyResult.accepted` is,
   * and the store cannot count what it never saw — only the reducer knows how many candidates an
   * observation implied.
   */
  readonly accepted: number;
}

export type FusionReducer = (
  state: WorldState,
  o: Observation,
  now: MonoMs,
  policies: FusionPolicies,
) => FusionOutcome;

/**
 * One observation, folded in.
 *
 * The shape is the same for every source and that is the point of ADR-0014: a reader turns the
 * payload into candidates, then every candidate goes through the *same* three gates in the same
 * order, so there is exactly one place where a fact can be admitted and exactly one place where a
 * rejection is counted.
 *
 * `atGameClock` comes from the observation itself where the source carries a clock — a GSI POST
 * does — and from the model's current clock otherwise. Never from `now`: `now` is wall time, and
 * stamping a match clock from a wall clock is the bug the two brands exist to prevent.
 */
export const fuse: FusionReducer = (state, o, now, policies) => {
  const rejections: RejectionReason[] = [];
  const at: Timestamps = {
    observedAt: o.receivedAt,
    atGameClock: o.kind === 'gsi.payload' ? clockOf(o.payload) : (state.meta.clock?.value ?? null),
  };

  let candidates: readonly Candidate[] = [];
  let chat: readonly ChatLine[] = [];

  switch (o.kind) {
    case 'gsi.payload':
      candidates = readGsiPayload(o.payload, at);
      break;
    case 'log.event': {
      const read = readLogEvent(o.payload, at, (hero) => sideOf(state, hero));
      candidates = read.candidates;
      chat = read.chat;
      break;
    }
    case 'cv.detections': {
      const read = readCvDetections(o.payload, at);
      candidates = read.candidates;
      rejections.push(...read.rejections);
      break;
    }
    case 'api.enrichment':
      candidates = readApiEnrichment(o.payload, at);
      break;
  }

  let next = state;
  let accepted = 0;
  for (const candidate of candidates) {
    // 1. The confidence gate, before precedence: a below-threshold detection is not a weaker
    //    claim to be weighed, it is not a claim at all (§5.4).
    if (candidate.detector !== undefined) {
      if (!policies.confidence.admit(candidate.fact, candidate.detector)) {
        rejections.push({ field: candidate.path, why: 'below_threshold' });
        continue;
      }
    }

    // 2. Precedence, against whatever is there now — which may be a fact this same observation
    //    just wrote, so a batch containing two readings of one field resolves within itself.
    const existing = readFact(next, candidate.path);
    const verdict = policies.precedence.canWrite(candidate.path, candidate.fact, existing, now);
    if (!verdict.write) {
      rejections.push({ field: candidate.path, why: verdict.reason });
      continue;
    }

    const written = writeFact(next, candidate.path, candidate.fact);
    if (written === next) {
      // `writeFact` returns its input for a path it does not recognise. That is a programming
      // error rather than a source problem, and it must be visible: a silently discarded
      // candidate is a field that never updates and never explains why.
      rejections.push({ field: candidate.path, why: 'unparsed' });
      continue;
    }
    next = written;
    accepted += 1;
  }

  /*
   * The two rings are the one deliberate exception to structural sharing, and it is worth being
   * explicit rather than letting someone discover it.
   *
   * `chat` and `history` are bounded append-only logs owned by the store, not fields: they carry
   * no `Fact` envelope, they are not addressable by `FieldPath`, and they never appear in a
   * delta. Every version shares the same ring object, so a snapshot's view of them is as of the
   * moment it is *read*, not the moment it was taken. Copying them per observation would make
   * that guarantee uniform at the cost of an allocation per POST for a view nobody diffs.
   *
   * A chat line still bumps the version — via a fresh state identity below — because otherwise a
   * chat-only observation would be completely invisible to `packages/events`.
   */
  for (const line of chat) next.chat.push(line, at.atGameClock, now);

  if (next === state && chat.length === 0) return { state, rejections, accepted };
  return {
    state: { ...next, meta: { ...next.meta, lastUpdatedAt: now } },
    rejections,
    accepted,
  };
};

/**
 * Which side a hero is on, from the roster the model already has.
 *
 * `self.hero` counts as an ally: the kill feed names the player like anyone else, and a death
 * that failed to land on `self.alive` because the player is not in `allies` would be the most
 * conspicuous possible gap.
 */
function sideOf(state: WorldState, hero: HeroId): 'allies' | 'enemies' | undefined {
  if (state.enemies.has(hero)) return 'enemies';
  if (state.allies.has(hero)) return 'allies';
  return undefined;
}

/**
 * External enrichment (dota2 §2.4) is out of band and pre-game, so the only thing it writes into
 * the model is the patch version — everything else it fetches belongs to `packages/context`'s
 * Tier 1 preamble and never enters fusion at all.
 */
function readApiEnrichment(payload: unknown, at: Timestamps): readonly Candidate[] {
  const patch = readString(asRecord(payload), 'patch');
  return patch === undefined
    ? []
    : [{ path: fieldPath('meta', 'patch'), fact: apiFact(patch, at, 'enrichment') }];
}

/**
 * The fact envelope — the central type of the whole subsystem.
 *
 * The hard part of state capture is not collecting facts, it is keeping the difference between
 * them intact all the way to the agent. A pipeline that flattens a 0.55-confidence minimap blob
 * and a GSI health value into the same `number` has discarded the only thing that stops Riki
 * confidently getting someone killed.
 *
 * So provenance, confidence and age travel in the type, and a fact cannot be constructed without
 * them. See docs/design/state-capture-architecture.md §3.2.
 *
 * ⚠ `Fact` and `Confidence` cross the language boundary as part of CV detections, so they become
 * zod schemas in @riki/protocol at REPO_SKELETON.md §10 step 2, with the non-optionality of
 * `confidence` enforced there too (§4 of that document).
 */

import type { GameClock, MonoMs } from './time.js';

/**
 * Where a fact came from. Ranked per field class, not globally — see fusion/precedence.ts, where
 * `cv` outranks nothing on `self.*` and outranks everything on `enemies[].position`.
 */
export type FactSource = 'gsi' | 'log' | 'cv' | 'api' | 'derived';

/** 0–1. Exactly 1.0 for gsi/log/api; a detector match score for cv. */
export type Confidence = number & { readonly __brand: 'Confidence' };

/** Names a CV detector, for per-detector thresholds and for the drift monitor. */
export type DetectorId = string & { readonly __brand: 'DetectorId' };

/**
 * When an observation was made, on both clocks. `atGameClock` is null when the match had no clock
 * yet — draft and loading — which is not the same as clock zero.
 */
export interface Timestamps {
  readonly observedAt: MonoMs;
  readonly atGameClock: GameClock | null;
}

/**
 * One value, and everything needed to judge it.
 *
 * **Age is not a field.** It is computed at read time from `observedAt` and the `now` passed in,
 * because a stored age is an age that is already wrong by the time anyone reads it.
 */
export interface Fact<T> {
  readonly value: T;
  readonly source: FactSource;
  readonly confidence: Confidence;
  readonly observedAt: MonoMs;
  readonly atGameClock: GameClock | null;
  /** Opaque per-source detail for debugging: detector id, log line number, GSI component. */
  readonly origin?: string;
}

// -----------------------------------------------------------------------------------------------
// Factories — the only way to build a Fact
// -----------------------------------------------------------------------------------------------

/**
 * `Fact` is not constructed as an object literal anywhere outside these. The point is `cvFact`:
 * it is the only factory that takes a confidence and it *requires* one, so REPO_SKELETON.md §4's
 * rule — a CV position constructible without a score will eventually be rendered as certain —
 * becomes unconstructible rather than merely remembered.
 *
 * **Only fusion calls these.** A source emits a payload; the reducer decides what facts it implies
 * and stamps them. That is why `packages/gsi` and `packages/log-tail` do not need this module, and
 * why they can stay unaware that a world model exists at all (ADR-0014).
 */
export declare function gsiFact<T>(value: T, at: Timestamps, origin?: string): Fact<T>;

export declare function logFact<T>(value: T, at: Timestamps, origin?: string): Fact<T>;

export declare function cvFact<T>(
  value: T,
  at: Timestamps,
  confidence: Confidence,
  detector: DetectorId,
): Fact<T>;

export declare function apiFact<T>(value: T, at: Timestamps, origin?: string): Fact<T>;

/**
 * A derived value inherits the *minimum* confidence and the *oldest* `observedAt` of its inputs.
 * "Gold until Diffusal", computed from a stale net-worth estimate, is itself stale and says so.
 */
export declare function derivedFact<T>(
  value: T,
  at: Timestamps,
  from: readonly Fact<unknown>[],
): Fact<T>;

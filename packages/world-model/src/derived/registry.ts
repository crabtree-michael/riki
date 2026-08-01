/**
 * Derived state — where most of the coaching value lives, and all of it cheap local arithmetic
 * rather than LLM work.
 *
 * Two properties worth keeping:
 *
 * - **Lazy and memoised per version**, not scheduled. If derived state is computed on first read
 *   of a snapshot and cached against the version, a burst of eight GSI updates between two agent
 *   turns costs one computation instead of eight — with no timer, no coalescing window, and no way
 *   to read a half-updated view. dota2 §5's 10 Hz coalescing target is met by the structure rather
 *   than enforced by a scheduler.
 * - **`null` when inputs are too stale to answer honestly.** "You can afford buyback", computed
 *   from forty-second-old gold, is worse than no answer.
 *
 * One rule per file in `rules/`, each with its own unit test. This is deliberately the cheapest
 * change in the system: dota2 §4 puts most of the coaching value here.
 *
 * See docs/design/state-capture-architecture.md §5.7.
 */

import type { Fact } from '../fact.js';
import type { FieldPath, WorldState } from '../state.js';
import type { GameClock, MonoMs } from '../time.js';

export type DerivedId = string & { readonly __brand: 'DerivedId' };

export interface DerivedRule<T> {
  readonly id: DerivedId;
  /** Drives memoisation: only rules whose dependencies changed are recomputed. */
  readonly dependsOn: readonly FieldPath[];
  compute(state: WorldState, now: MonoMs, clock: GameClock | null): Fact<T> | null;
}

/** Resolved lazily on first read of a snapshot, then cached against that snapshot's version. */
export interface DerivedView {
  get<T>(id: DerivedId): Fact<T> | null;
  readonly ids: readonly DerivedId[];
}

export interface DerivedRegistry {
  register<T>(rule: DerivedRule<T>): void;
  resolve(state: WorldState, now: MonoMs, clock: GameClock | null): DerivedView;
}

export declare function createDerivedRegistry(): DerivedRegistry;

/**
 * The set dota2 §4 asks for. Each is a file in `rules/`; the ids are named here so the snapshot
 * renderer and the agent tool surface can refer to them without importing every rule.
 */
export declare const DERIVED_IDS: {
  readonly goldUntilItem: DerivedId;
  readonly buybackAffordable: DerivedId;
  readonly roshanWindow: DerivedId;
  readonly runeTimings: DerivedId;
  readonly stackTiming: DerivedId;
  readonly powerSpikeIn: DerivedId;
  readonly netWorthLead: DerivedId;
  readonly unseenEnemies: DerivedId;
};

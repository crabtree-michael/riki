/**
 * The immutable read view. This is the whole of what `packages/context` and `packages/events` see.
 *
 * The load-bearing detail is `get()`: it returns the fact *with* its staleness classification, and
 * there is no accessor that hands back a bare `T`. That is mildly annoying at every call site,
 * which is the intended effect — the annoyance is the reminder that a bare value is not what the
 * agent should be told.
 *
 * See docs/design/state-capture-architecture.md §7.1.
 */

import type { DerivedView } from './derived/registry.js';
import type { Fact } from './fact.js';
import type { Staleness } from './fusion/staleness.js';
import type { EnemyState, FieldPath, HeroId, WorldState } from './state.js';
import type { GameClock, MonoMs } from './time.js';

export interface StaleFact<T> {
  readonly fact: Fact<T>;
  readonly staleness: Staleness;
}

export interface EnemyView {
  readonly hero: HeroId;
  readonly state: EnemyState;
  /** The staleness of `position`, which is the field that decides how the enemy is rendered. */
  readonly staleness: Staleness;
}

/**
 * Frozen, cheap to produce, and safe to hand to anything. Derived state is resolved on first
 * access and cached against `version`.
 */
export interface WorldSnapshot {
  readonly version: number;
  readonly now: MonoMs;
  readonly clock: GameClock | null;
  readonly state: WorldState;
  readonly derived: DerivedView;

  get<T>(path: FieldPath): StaleFact<T> | undefined;
  enemies(): readonly EnemyView[];
  /** Drives the snapshot's `unseen >20s:` line — heroes with no fresh position, not absent ones. */
  unseenFor(seconds: number): readonly HeroId[];
}

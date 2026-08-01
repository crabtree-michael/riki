/**
 * Ageing — and the two-clock rule.
 *
 * > **Tactical facts age in match time. Pipeline facts age in wall time.**
 *
 * While the game is paused nothing on the map moves, so an enemy position from ten seconds ago is
 * still exactly true, and ageing it out would make Riki forget the map during every pause. But GSI
 * liveness must keep ageing in wall time, because a client that has stopped POSTing for forty
 * seconds of paused game is still gone. One `basis` field, and both behave correctly.
 *
 * See docs/design/state-capture-architecture.md §5.5.
 */

import type { Fact } from '../fact.js';
import type { FieldPath } from '../state.js';
import type { GameClock, MonoMs } from '../time.js';

export type AgeBasis = 'wall' | 'game';

export type Staleness = 'fresh' | 'aging' | 'stale' | 'expired';

export interface AgePolicy {
  readonly basis: AgeBasis;
  readonly freshMs: number;
  readonly agingMs: number;
  readonly expiredMs: number;
}

export interface Age {
  readonly ms: number;
  readonly basis: AgeBasis;
}

export interface StalenessPolicy {
  policyFor(field: FieldPath): AgePolicy;
  ageOf(fact: Fact<unknown>, now: MonoMs, clock: GameClock | null): Age;
  classify(field: FieldPath, fact: Fact<unknown>, now: MonoMs, clock: GameClock | null): Staleness;
}

export declare function createStalenessPolicy(
  policies: ReadonlyMap<FieldPath, AgePolicy>,
): StalenessPolicy;

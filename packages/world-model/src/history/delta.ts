/**
 * What changed between two versions.
 *
 * `WorldDelta` is the entire input to `packages/events`. That module never sees an `Observation`,
 * which is what stops "did the agent already mention this" logic from creeping into fusion.
 *
 * See docs/design/state-capture-architecture.md §5.8 and §7.1.
 */

import type { Fact } from '../fact.js';
import type { FieldPath, WorldState } from '../state.js';
import type { GameClock } from '../time.js';

export interface FieldChange {
  readonly path: FieldPath;
  readonly before: Fact<unknown> | undefined;
  readonly after: Fact<unknown> | undefined;
}

export interface WorldDelta {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly atGameClock: GameClock | null;
  readonly changes: readonly FieldChange[];
}

export interface DeltaComputer {
  compute(prev: WorldState, next: WorldState): WorldDelta;
}

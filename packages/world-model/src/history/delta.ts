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
import { flattenFacts } from '../state.js';
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

/**
 * A field is "changed" when its *fact* changed identity, not when its value did.
 *
 * That is deliberate and it is the cheap half of the design: fusion only ever replaces a fact
 * when precedence admitted a write, so reference inequality already means "something new landed
 * here" — no deep comparison, and a re-observation of the same value still counts as news
 * because its age reset. `packages/events` decides whether that is interesting; this only
 * reports it.
 */
export function createDeltaComputer(): DeltaComputer {
  return {
    compute(prev: WorldState, next: WorldState): WorldDelta {
      const before = flattenFacts(prev);
      const after = flattenFacts(next);
      const changes: FieldChange[] = [];

      for (const [path, fact] of after) {
        const old = before.get(path);
        if (old !== fact) changes.push({ path, before: old, after: fact });
      }
      // Disappearances: only `reset()` produces these, but a delta that omitted them would let a
      // reader keep rendering a field the model no longer has.
      for (const [path, fact] of before) {
        if (!after.has(path)) changes.push({ path, before: fact, after: undefined });
      }

      return {
        fromVersion: prev.version,
        toVersion: next.version,
        atGameClock: next.meta.clock?.value ?? null,
        changes,
      };
    },
  };
}

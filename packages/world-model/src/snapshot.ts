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

import type { DerivedRegistry, DerivedView } from './derived/registry.js';
import type { Fact } from './fact.js';
import type { Staleness, StalenessPolicy } from './fusion/staleness.js';
import type { EnemyState, FieldPath, HeroId, WorldState } from './state.js';
import { heroField, readFact } from './state.js';
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

export interface SnapshotOptions {
  readonly state: WorldState;
  readonly now: MonoMs;
  readonly clock: GameClock | null;
  readonly staleness: StalenessPolicy;
  readonly derived: DerivedRegistry;
}

/**
 * Cheap to produce and frozen at the top level.
 *
 * Frozen and not deep-frozen: `WorldState` is already `readonly` throughout and rebuilt by
 * structural sharing on every write, so deep-freezing per snapshot would walk the whole model at
 * turn boundaries to re-state what the types say. The one genuinely mutable thing reachable from
 * here is the pair of rings (see fusion/reducer.ts), and freezing would not have changed that.
 *
 * `derived` is resolved eagerly as a *view* and lazily as *values*: building it costs nothing, and
 * a rule only runs if someone asks for its id.
 */
export function createSnapshot(opts: SnapshotOptions): WorldSnapshot {
  const { state, now, clock, staleness } = opts;

  return Object.freeze<WorldSnapshot>({
    version: state.version,
    now,
    clock,
    state,
    derived: opts.derived.resolve(state, now, clock),

    get<T>(path: FieldPath): StaleFact<T> | undefined {
      const fact = readFact(state, path);
      if (fact === undefined) return undefined;
      return { fact: fact as Fact<T>, staleness: staleness.classify(path, fact, now, clock) };
    },

    enemies(): readonly EnemyView[] {
      return [...state.enemies].map(([hero, enemyState]) => ({
        hero,
        state: enemyState,
        // An enemy with no position at all is `expired`, not absent: nothing has been observed,
        // which is the strongest possible statement of "we do not know where they are".
        staleness:
          enemyState.position === undefined
            ? 'expired'
            : staleness.classify(
                heroField('enemies', hero, 'position'),
                enemyState.position,
                now,
                clock,
              ),
      }));
    },

    unseenFor(seconds: number): readonly HeroId[] {
      const threshold = seconds * 1000;
      return [...state.enemies]
        .filter(([, enemyState]) => {
          if (enemyState.position === undefined) return true;
          return staleness.ageOf(enemyState.position, now, clock).ms >= threshold;
        })
        .map(([hero]) => hero);
    },
  });
}

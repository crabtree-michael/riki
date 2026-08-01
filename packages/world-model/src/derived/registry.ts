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
import { flattenFacts } from '../state.js';
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

/**
 * Laziness is what delivers the coalescing property, and it lives in the *view*: `resolve` builds
 * a `DerivedView` without computing anything, and each rule runs at most once, on first `get`.
 * Seven of eight GSI updates never have a snapshot taken of them, so their derived state is never
 * computed at all — which is the §5.7 claim, obtained from the structure rather than a timer.
 *
 * ⚠ Deviation from §5.7's "only recomputes rules whose dependencies changed": there is no
 * cross-version memo. A rule's answer depends on `now` as well as on its inputs — that is the
 * point of ageing — so a cache keyed on dependency identity would have to be invalidated on every
 * clock tick, which is every call. `dependsOn` is still load-bearing: a rule none of whose
 * dependencies have ever been observed is skipped without calling `compute`, which is what keeps
 * a mid-draft snapshot from running eight rules that can only answer null.
 */
export function createDerivedRegistry(
  rules: readonly DerivedRule<unknown>[] = [],
): DerivedRegistry {
  const registered = new Map<DerivedId, DerivedRule<unknown>>();
  for (const rule of rules) registered.set(rule.id, rule);

  return {
    register<T>(rule: DerivedRule<T>): void {
      registered.set(rule.id, rule);
    },

    resolve(state: WorldState, now: MonoMs, clock: GameClock | null): DerivedView {
      const memo = new Map<DerivedId, Fact<unknown> | null>();

      return {
        get<T>(id: DerivedId): Fact<T> | null {
          const cached = memo.get(id);
          if (cached !== undefined) return cached as Fact<T> | null;

          const rule = registered.get(id);
          let value: Fact<unknown> | null = null;
          if (rule !== undefined && hasAnyDependency(state, rule.dependsOn)) {
            value = rule.compute(state, now, clock);
          }
          memo.set(id, value);
          return value as Fact<T> | null;
        },

        get ids(): readonly DerivedId[] {
          return [...registered.keys()];
        },
      };
    },
  };
}

/**
 * Dependency paths may contain `*` for a hero id, because a rule about enemies cannot name them
 * ahead of the draft. Presence, not freshness: whether a fact is *too old* to answer with is the
 * rule's own call, and §5.7 is explicit that returning null in that case is its job.
 */
function hasAnyDependency(state: WorldState, dependsOn: readonly FieldPath[]): boolean {
  if (dependsOn.length === 0) return true;
  const present = flattenFacts(state);
  return dependsOn.some((dep) =>
    dep.includes('*')
      ? [...present.keys()].some((path) => matchesPattern(dep, path))
      : present.has(dep),
  );
}

function matchesPattern(pattern: string, path: string): boolean {
  const a = pattern.split('.');
  const b = path.split('.');
  return a.length === b.length && a.every((part, i) => part === '*' || part === b[i]);
}

/**
 * The set dota2 §4 asks for. Each is a file in `rules/`; the ids are named here so the snapshot
 * renderer and the agent tool surface can refer to them without importing every rule.
 */
export const DERIVED_IDS = {
  goldUntilItem: 'goldUntilItem' as DerivedId,
  buybackAffordable: 'buybackAffordable' as DerivedId,
  roshanWindow: 'roshanWindow' as DerivedId,
  runeTimings: 'runeTimings' as DerivedId,
  stackTiming: 'stackTiming' as DerivedId,
  powerSpikeIn: 'powerSpikeIn' as DerivedId,
  netWorthLead: 'netWorthLead' as DerivedId,
  unseenEnemies: 'unseenEnemies' as DerivedId,
} as const;

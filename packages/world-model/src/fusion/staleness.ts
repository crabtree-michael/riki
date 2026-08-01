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

/**
 * Policy keys are matched by segment, with `*` standing for exactly one segment, most-specific
 * first. Hero ids are not known ahead of time, so `enemies.*.position` is the only way to write
 * the rule that matters most in this table.
 */
export type AgePolicyPattern = string;

/**
 * The starting table. Every number is *(tunable)* and none of them has been measured against a
 * real match — they are ordered by reasoning, not by data:
 *
 * - `self.*` ages in **game** time and expires slowly. During a pause your HP does not change,
 *   and GSI going quiet is `GsiLiveness`'s job to notice, not this one's.
 * - `meta.*` ages in **wall** time. It describes the session rather than the map, and a match
 *   clock that has not moved in forty wall seconds is exactly the thing that should look stale.
 * - `enemies.*.position` expires at 20 s, which is where `packages/context` switches to
 *   `unseen >20s`. Past that the fact is not worth rendering and `lastSeenAt` — expiring two
 *   minutes later — carries the hypothesis instead.
 * - `enemies.*.level` and `itemsSeen` barely age at all. An item seen four minutes ago is still
 *   in the inventory; a position from four minutes ago is nothing.
 */
export const DEFAULT_AGE_POLICIES: ReadonlyMap<AgePolicyPattern, AgePolicy> = new Map([
  ['meta.*', { basis: 'wall', freshMs: 2_000, agingMs: 10_000, expiredMs: 35_000 }],
  ['self.*', { basis: 'game', freshMs: 1_500, agingMs: 5_000, expiredMs: 60_000 }],
  ['map.daytime', { basis: 'game', freshMs: 5_000, agingMs: 30_000, expiredMs: 120_000 }],
  ['map.buildings', { basis: 'game', freshMs: 2_000, agingMs: 15_000, expiredMs: 120_000 }],
  ['map.roshanState', { basis: 'game', freshMs: 30_000, agingMs: 120_000, expiredMs: 900_000 }],
  ['map.wardsSeen', { basis: 'game', freshMs: 5_000, agingMs: 30_000, expiredMs: 180_000 }],
  ['*.*.position', { basis: 'game', freshMs: 2_000, agingMs: 6_000, expiredMs: 20_000 }],
  ['*.*.lastSeenAt', { basis: 'game', freshMs: 20_000, agingMs: 60_000, expiredMs: 150_000 }],
  ['*.*.alive', { basis: 'game', freshMs: 1_000, agingMs: 5_000, expiredMs: 60_000 }],
  ['*.*.respawnIn', { basis: 'game', freshMs: 1_000, agingMs: 5_000, expiredMs: 60_000 }],
  ['*.*.hero', { basis: 'game', freshMs: 600_000, agingMs: 3_600_000, expiredMs: 7_200_000 }],
  ['*.*.level', { basis: 'game', freshMs: 10_000, agingMs: 60_000, expiredMs: 600_000 }],
  ['*.*.netWorth', { basis: 'game', freshMs: 10_000, agingMs: 60_000, expiredMs: 300_000 }],
  ['*.*.itemsSeen.*', { basis: 'game', freshMs: 30_000, agingMs: 180_000, expiredMs: 900_000 }],
]);

export const FALLBACK_AGE_POLICY: AgePolicy = {
  basis: 'game',
  freshMs: 2_000,
  agingMs: 10_000,
  expiredMs: 60_000,
};

function matches(pattern: string, segments: readonly string[]): boolean {
  const parts = pattern.split('.');
  if (parts.length !== segments.length) return false;
  return parts.every((part, i) => part === '*' || part === segments[i]);
}

/** Fewer wildcards wins, so `map.roshanState` beats `map.*` without depending on insertion order. */
function specificity(pattern: string): number {
  return pattern.split('.').filter((part) => part !== '*').length;
}

export function createStalenessPolicy(
  policies: ReadonlyMap<AgePolicyPattern, AgePolicy> = DEFAULT_AGE_POLICIES,
  fallback: AgePolicy = FALLBACK_AGE_POLICY,
): StalenessPolicy {
  const ordered = [...policies.entries()].sort(([a], [b]) => specificity(b) - specificity(a));
  const resolved = new Map<FieldPath, AgePolicy>();

  const policyFor = (field: FieldPath): AgePolicy => {
    const cached = resolved.get(field);
    if (cached !== undefined) return cached;

    const segments = field.split('.');
    const hit = ordered.find(([pattern]) => matches(pattern, segments))?.[1] ?? fallback;
    resolved.set(field, hit);
    return hit;
  };

  return {
    policyFor,

    /**
     * Field-free, so it cannot consult a policy: it asks for the tactical basis and takes the
     * wall-time fallback when the match has no clock. Callers that know the field should use
     * `classify`, which uses that field's declared basis.
     */
    ageOf(fact: Fact<unknown>, now: MonoMs, clock: GameClock | null): Age {
      return ageInBasis(fact, now, clock, 'game');
    },

    classify(field, fact, now, clock): Staleness {
      const policy = policyFor(field);
      const age = ageInBasis(fact, now, clock, policy.basis);
      if (age.ms < policy.freshMs) return 'fresh';
      if (age.ms < policy.agingMs) return 'aging';
      if (age.ms < policy.expiredMs) return 'stale';
      return 'expired';
    },
  };
}

/**
 * The two-clock rule, in one function.
 *
 * A `game` age needs a match clock at both ends: the one stamped on the fact and the one now.
 * Either being absent means the match had no clock at that moment — draft, loading, a dropout
 * before the horn — and wall time is then the only honest answer rather than a reason to refuse
 * one. That fallback is what keeps ageing defined during the phases where nothing has a clock.
 */
export function ageInBasis(
  fact: Fact<unknown>,
  now: MonoMs,
  clock: GameClock | null,
  basis: AgeBasis,
): Age {
  if (basis === 'game' && clock !== null && fact.atGameClock !== null) {
    // Clamp at zero: a fact stamped with a clock ahead of `clock` is a reordered observation, not
    // a fact from the future, and a negative age would classify it as maximally fresh forever.
    return { ms: Math.max(0, (clock - fact.atGameClock) * 1000), basis: 'game' };
  }
  return { ms: Math.max(0, now - fact.observedAt), basis: 'wall' };
}

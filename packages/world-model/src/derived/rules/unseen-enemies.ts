/**
 * Which enemies nobody has seen recently.
 *
 * This is the rule dota2 §6.2 cares most about getting right, because of the line it feeds:
 *
 * ```
 * unseen >20s: ws, zeus            ← treat as unknown, not absent
 * ```
 *
 * The distinction in that comment is the whole rule. An enemy with no fresh position is *unknown*,
 * and the model must be able to say so; an enemy simply omitted reads as absent, and "they're not
 * around" is how someone walks into four people.
 */

import type { Fact } from '../../fact.js';
import { derivedFact } from '../../fact.js';
import type { HeroId } from '../../state.js';
import { fieldPath, heroField } from '../../state.js';
import type { StalenessPolicy } from '../../fusion/staleness.js';
import type { DerivedRule } from '../registry.js';
import { DERIVED_IDS } from '../registry.js';

export interface UnseenEnemy {
  readonly hero: HeroId;
  /** Milliseconds since the last position, on the field's own basis — null if never seen at all. */
  readonly ageMs: number | null;
  /** The last known position, if there is one. A hypothesis, and rendered as one. */
  readonly lastSeenAt: { readonly x: number; readonly y: number } | null;
}

export interface UnseenEnemiesOptions {
  /**
   * The policy is injected rather than reached for, because `DerivedRule.compute` is pure and
   * gets no policies (§5.7). Staleness is the one thing this rule cannot compute itself: the
   * two-clock rule lives in that policy, and re-deriving an age here from whichever clock was to
   * hand is exactly how the two would drift apart.
   */
  readonly staleness: StalenessPolicy;
  /** Matches `packages/context`'s `unseenAfterMs`. 20 s (tunable). */
  readonly unseenAfterMs?: number;
}

export const DEFAULT_UNSEEN_AFTER_MS = 20_000;

export function createUnseenEnemiesRule(
  opts: UnseenEnemiesOptions,
): DerivedRule<readonly UnseenEnemy[]> {
  const threshold = opts.unseenAfterMs ?? DEFAULT_UNSEEN_AFTER_MS;

  return {
    id: DERIVED_IDS.unseenEnemies,
    dependsOn: [fieldPath('enemies', '*', 'hero')],
    compute(state, now, clock): Fact<readonly UnseenEnemy[]> | null {
      if (state.enemies.size === 0) return null;

      const inputs: Fact<unknown>[] = [];
      const unseen: UnseenEnemy[] = [];

      for (const [hero, enemy] of state.enemies) {
        inputs.push(enemy.hero);

        if (enemy.position === undefined) {
          // Never observed. Not the same as observed-to-be-elsewhere, and the null age says so.
          unseen.push({ hero, ageMs: null, lastSeenAt: lastSeen(enemy.lastSeenAt) });
          continue;
        }

        const path = heroField('enemies', hero, 'position');
        const age = opts.staleness.ageOf(enemy.position, now, clock);
        const staleness = opts.staleness.classify(path, enemy.position, now, clock);
        if (age.ms >= threshold || staleness === 'expired') {
          inputs.push(enemy.position);
          unseen.push({ hero, ageMs: age.ms, lastSeenAt: lastSeen(enemy.lastSeenAt) });
        }
      }

      return derivedFact<readonly UnseenEnemy[]>(
        unseen,
        { observedAt: now, atGameClock: clock },
        inputs,
      );
    },
  };
}

function lastSeen(
  fact: Fact<{ readonly x: number; readonly y: number }> | undefined,
): { readonly x: number; readonly y: number } | null {
  return fact?.value ?? null;
}

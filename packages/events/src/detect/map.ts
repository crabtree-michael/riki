/**
 * `enemy_missing` — the one dota2 §6.2 cares most about getting right.
 *
 * ```
 * unseen >20s: ws, zeus            ← treat as unknown, not absent
 * ```
 *
 * `packages/world-model`'s `unseenEnemies` rule already draws the distinction that matters: an
 * enemy with no fresh position is *unknown*, not absent, and "they're not around" is how somebody
 * walks into four people. This detector's only additions are a longer threshold than the snapshot's
 * — a hero unseen for 20 s is worth *rendering*, one unseen for 33 s is worth *interrupting for* —
 * and the decision below about granularity.
 *
 * **One detection per hero, not one for the group.** Per-hero is what lets the topic be
 * `{ of: 'hero', hero }`, which is what lets the novelty gate say "I already told you about SF".
 * The group is not lost: `magnitude` takes the larger of *how long this one has been gone* and
 * *what fraction of the enemy team is gone at once*, so three missing heroes rank above one
 * immediately rather than after thirty more seconds. Only the highest-ranked candidate is ever
 * spoken (§5.5), so the per-hero fan-out costs nothing in noise.
 *
 * **Never-observed heroes are excluded.** `UnseenEnemy.ageMs` is null when a hero has no position
 * at all, which is the state of every enemy in a match with no CV sidecar. Firing on that would
 * turn "we cannot see the map" into five interruptions a minute; the correct behaviour is that this
 * detector goes quiet when the sidecar does, and coaching-architecture.md §10 gives it a row.
 *
 * See docs/design/coaching-trigger-architecture.md §3.2.
 */

import type { UnseenEnemy, WorldSnapshot } from '@riki/world-model';
import { DERIVED_IDS, heroField } from '@riki/world-model';
import type { EventDetector } from '../contracts.js';
import type { TriggerConfig } from '../config.js';
import type { Detection } from '../types.js';
import { detectionKey } from '../types.js';
import { clamp01, confidenceOf, enemyAlive, factAt, ramp } from './util.js';

const SECONDS = 1000;

export const enemyMissing: EventDetector = {
  kind: 'enemy_missing',

  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[] {
    const unseen = world.derived.get<readonly UnseenEnemy[]>(DERIVED_IDS.unseenEnemies);
    if (unseen === null) return [];

    const missing = unseen.value.filter(
      (entry) =>
        entry.ageMs !== null &&
        entry.ageMs >= cfg.missingAfterSeconds * SECONDS &&
        // Known dead is not missing. It is the *other* detector's material, and telling somebody
        // to watch out for a hero on the respawn timer is worse than saying nothing.
        enemyAlive(world, entry.hero) !== false,
    );
    if (missing.length === 0) return [];

    const teamSize = world.enemies().length;
    const groupTerm = teamSize === 0 ? 0 : clamp01(missing.length / teamSize);

    return missing.map((entry) => {
      const ageSeconds = (entry.ageMs ?? 0) / SECONDS;
      const position = factAt(world, heroField('enemies', entry.hero, 'position'));

      return {
        kind: 'enemy_missing',
        key: detectionKey('enemy_missing', entry.hero),
        topic: { of: 'hero', hero: entry.hero },
        magnitude: Math.max(
          ramp(ageSeconds, cfg.missingAfterSeconds, cfg.missingSaturationSeconds),
          groupTerm,
        ),
        // No deadline. An enemy who has been missing for forty seconds does not stop being worth
        // mentioning on a clock — they stop being worth mentioning when they are seen.
        actWithinSeconds: null,
        confidence: confidenceOf(unseen, position),
        text:
          missing.length === 1
            ? `${entry.hero} unseen ${String(Math.round(ageSeconds))}s`
            : `${String(missing.length)} enemies unseen, ${entry.hero} ${String(Math.round(ageSeconds))}s`,
        atGameClock: unseen.atGameClock ?? world.clock,
      } satisfies Detection;
    });
  },
};

/**
 * The three that are about a fight: `low_hp_no_escape`, `ult_ready`, `enemy_core_dead_window`.
 *
 * All three depend on seeing enemies, which means all three inherit the CV sidecar's availability
 * and all three go quiet when it dies. That is the correct degradation and not a gap: with no
 * positions there is no fight to advise about, and coaching-architecture.md §10's rule is that Riki
 * says less rather than something wrong.
 *
 * See docs/design/coaching-trigger-architecture.md §3.2.
 */

import type { AbilityState, ItemState, WorldSnapshot } from '@riki/world-model';
import { heroField } from '@riki/world-model';
import type { EventDetector } from '../contracts.js';
import type { TriggerConfig } from '../config.js';
import type { Detection } from '../types.js';
import { detectionKey, eventTopic } from '../types.js';
import {
  SELF_ABILITIES,
  SELF_HEALTH,
  SELF_ITEMS,
  anyEnemyVisible,
  clockOf,
  confidenceOf,
  factAt,
  fractionOf,
  nearbyEnemies,
  ramp,
  selfAlive,
} from './util.js';

/**
 * `low_hp_no_escape` — the only kind where being late is the same as being wrong, and the reason
 * it carries the highest weight in `config.ts`.
 *
 * "No escape" is decided from a **list of item ids in config**, not from the ability list.
 * `AbilityState` carries no "is this an escape" flag and `packages/world-model` has no reason to
 * grow one; hero-specific ability knowledge is reference data, and reference data has exactly one
 * consumer in this product and it is the preamble (coaching §5.3). So this is deliberately
 * approximate — a Storm Spirit with mana is not trapped and this detector thinks he is — and §3.2
 * says the fix for the resulting noise is the salience weight, not a cleverer detector.
 */
export const lowHpNoEscape: EventDetector = {
  kind: 'low_hp_no_escape',

  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[] {
    if (!selfAlive(world)) return [];

    const health = factAt<{ readonly current: number; readonly max: number }>(world, SELF_HEALTH);
    const fraction = fractionOf(health);
    if (fraction === null || fraction > cfg.lowHpFraction) return [];

    // Being low is not the same as being in danger. Somebody at 20 % in the fountain does not need
    // to hear about it, and this is the check that keeps the highest-weighted kind honest.
    const near = nearbyEnemies(world, cfg);
    if (near.length === 0) return [];

    const items = factAt<readonly ItemState[]>(world, SELF_ITEMS);
    const escapes = new Set(cfg.escapeItems);
    const hasEscape =
      items?.value.some(
        (item) => item.castable && item.location === 'inventory' && escapes.has(String(item.id)),
      ) ?? false;
    if (hasEscape) return [];

    return [
      {
        kind: 'low_hp_no_escape',
        // One key: this is a *situation*, not a per-enemy condition, and the latch should clear
        // when the player is safe again rather than when a particular hero walks away.
        key: detectionKey('low_hp_no_escape'),
        topic: eventTopic('low_hp_no_escape'),
        magnitude: ramp(cfg.lowHpFraction - fraction, 0, cfg.lowHpFraction),
        actWithinSeconds: cfg.lowHpActWithinSeconds,
        confidence: confidenceOf(health, items),
        text: `low hp, ${String(near.length)} enemy nearby, no escape`,
        atGameClock: clockOf(world, health),
      },
    ];
  },
};

/**
 * `ult_ready` — and the visible-enemy requirement is the difference between coaching and an alarm
 * clock.
 *
 * "Your ult is up" said to somebody farming an empty lane is the single most irritating thing this
 * package could produce: it is true, it is useless, and it is available to say every few seconds
 * for the rest of the match. Requiring a fresh enemy position makes it advice about a fight that
 * might actually happen.
 *
 * It clears the speak threshold on its weight alone, which looks aggressive until you see what
 * bounds it: the **latch** (it is said once per time the ultimate comes up, not once per tick) and
 * the longest kind cooldown in the table. That is §4.1's separation working — the score says how
 * much it matters, and the gates say how often.
 */
export const ultReady: EventDetector = {
  kind: 'ult_ready',

  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[] {
    if (!selfAlive(world) || !anyEnemyVisible(world)) return [];
    void cfg;

    const abilities = factAt<readonly AbilityState[]>(world, SELF_ABILITIES);
    if (abilities === undefined) return [];

    const ready = abilities.value.find(
      (ability) => ability.isUltimate && ability.level > 0 && ability.castable,
    );
    if (ready === undefined) return [];

    return [
      {
        kind: 'ult_ready',
        key: detectionKey('ult_ready', ready.id),
        topic: eventTopic('ult_ready'),
        magnitude: 1,
        actWithinSeconds: null,
        confidence: confidenceOf(abilities),
        text: `ult ready (${ready.id})`,
        atGameClock: clockOf(world, abilities),
      },
    ];
  },
};

/**
 * `enemy_core_dead_window` — an enemy is down long enough that something is takeable.
 *
 * **The respawn timer is this detector's magnitude, not its deadline**, and that inversion is worth
 * the sentence. A fifty-second window is *more* valuable than a thirty-second one and *less*
 * urgent, so feeding the respawn into `actWithinSeconds` would have the urgency curve cancel
 * exactly the thing that makes the moment worth mentioning — §4.2 models lateness risk, and there
 * is no lateness risk here. What keeps this from being repeated for the whole window is the latch.
 */
export const enemyCoreDeadWindow: EventDetector = {
  kind: 'enemy_core_dead_window',

  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[] {
    const out: Detection[] = [];

    for (const view of world.enemies()) {
      const alive = view.state.alive;
      const respawn = view.state.respawnIn;
      if (alive === undefined || alive.value || respawn === undefined) continue;
      if (respawn.value < cfg.deadWindowSeconds) continue;

      out.push({
        kind: 'enemy_core_dead_window',
        key: detectionKey('enemy_core_dead_window', view.hero),
        topic: { of: 'hero', hero: view.hero },
        magnitude: ramp(respawn.value, cfg.deadWindowSeconds, cfg.deadWindowSaturationSeconds),
        actWithinSeconds: null,
        confidence: confidenceOf(
          alive,
          respawn,
          factAt(world, heroField('enemies', view.hero, 'respawnIn')),
        ),
        text: `${view.hero} dead ${String(Math.round(respawn.value))}s`,
        atGameClock: clockOf(world, respawn, alive),
      });
    }

    return out;
  },
};

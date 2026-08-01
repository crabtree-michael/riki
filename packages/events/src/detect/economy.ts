/**
 * The two gold moments: `can_afford_key_item` and `buyback_unaffordable`.
 *
 * Both read `packages/world-model`'s derived rules rather than doing arithmetic, and both inherit
 * the discipline those rules were written with — *"the arithmetic is trivial; the discipline is
 * entirely in when to refuse to answer"*. A rule that answers `null` because its inputs are too old
 * produces no detection here, which is the honest outcome: "you can afford buyback", computed from
 * forty-second-old gold, is worse than no answer.
 *
 * See docs/design/coaching-trigger-architecture.md §3.2, §3.3.
 */

import type { BuybackAffordable, GoldUntilItem, WorldSnapshot } from '@riki/world-model';
import { DERIVED_IDS } from '@riki/world-model';
import type { EventDetector } from '../contracts.js';
import type { TriggerConfig } from '../config.js';
import type { Detection } from '../types.js';
import { detectionKey, eventTopic } from '../types.js';
import { confidenceOf, ramp, selfAlive } from './util.js';

/**
 * `can_afford_key_item` — and it is **dark until something tells the world model what to save
 * for**.
 *
 * `goldUntilItem` answers `null` until `GoldUntilItemOptions.target` is set, and that package is
 * explicit that this is on purpose: there is no way to know a build target from the world model, so
 * the rule refuses rather than picking an item on the player's behalf. The thing that tells it is
 * the build benchmark in the preamble, which the composition root feeds in at draft.
 *
 * This is therefore the one detector whose silence means *"nobody configured me"* rather than
 * *"nothing is happening"*, which is why the engine counts detections per kind: a kind with zero
 * detections across a whole match is visible rather than assumed working (§3.3, §5.4).
 */
export const canAffordKeyItem: EventDetector = {
  kind: 'can_afford_key_item',

  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[] {
    void cfg;
    const gold = world.derived.get<GoldUntilItem>(DERIVED_IDS.goldUntilItem);
    if (gold === null || gold.value.remaining > 0) return [];

    return [
      {
        kind: 'can_afford_key_item',
        key: detectionKey('can_afford_key_item', gold.value.item),
        topic: { of: 'item', item: gold.value.item },
        // Affordability is binary. How *much* spare gold there is says nothing about how much the
        // advice matters, and a magnitude that grew with it would rank hoarding above buying.
        magnitude: 1,
        actWithinSeconds: null,
        confidence: confidenceOf(gold),
        text: `can afford ${gold.value.item}`,
        atGameClock: gold.atGameClock ?? world.clock,
      },
    ];
  },
};

/**
 * `buyback_unaffordable` — *"don't spend, you're three hundred short"*.
 *
 * The magnitude runs the way that reads backwards until you say the advice out loud: being
 * **closer** to affording buyback is more salient, not less. Somebody 1,800 gold short cannot act
 * on this and telling them is just bad news; somebody 200 short can hold an item purchase for one
 * camp, and that is coaching.
 */
export const buybackUnaffordable: EventDetector = {
  kind: 'buyback_unaffordable',

  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[] {
    if (!selfAlive(world)) return [];

    const buyback = world.derived.get<BuybackAffordable>(DERIVED_IDS.buybackAffordable);
    if (buyback === null || buyback.value.affordable) return [];
    if (buyback.value.shortBy > cfg.buybackShortfallGold) return [];

    return [
      {
        kind: 'buyback_unaffordable',
        key: detectionKey('buyback_unaffordable'),
        topic: eventTopic('buyback_unaffordable'),
        magnitude: 1 - ramp(buyback.value.shortBy, 0, cfg.buybackShortfallGold),
        actWithinSeconds: null,
        confidence: confidenceOf(buyback),
        text: `buyback short by ${String(Math.round(buyback.value.shortBy))}`,
        atGameClock: buyback.atGameClock ?? world.clock,
      },
    ];
  },
};

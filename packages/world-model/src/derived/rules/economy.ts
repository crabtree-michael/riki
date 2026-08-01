/**
 * The gold rules: time until an item, whether buyback is affordable, and the net-worth lead.
 *
 * dota2 §6.2 is specific about why these exist — `buy: diffusal2 in ~40s` is far better than
 * making the model do gold arithmetic it will sometimes get wrong. The arithmetic is trivial; the
 * discipline is entirely in *when to refuse to answer*.
 */

import type { Fact } from '../../fact.js';
import { derivedFact } from '../../fact.js';
import type { FieldPath, ItemId } from '../../state.js';
import { fieldPath } from '../../state.js';
import type { DerivedRule } from '../registry.js';
import { DERIVED_IDS } from '../registry.js';

const GOLD_PATH: FieldPath = fieldPath('self', 'gold');
const GPM_PATH: FieldPath = fieldPath('self', 'gpm');
const BUYBACK_PATH: FieldPath = fieldPath('self', 'buyback');
const NET_WORTH_PATH: FieldPath = fieldPath('self', 'netWorth');

export interface GoldUntilItem {
  readonly item: ItemId;
  readonly cost: number;
  readonly have: number;
  readonly remaining: number;
  /** Null when GPM is zero or unknown: "in ∞ seconds" is not an answer. */
  readonly etaSeconds: number | null;
}

export interface GoldUntilItemOptions {
  /**
   * What the player is saving for. There is no way to know this from the world model — it comes
   * from the build benchmark in `packages/context`'s Tier 1 preamble (dota2 §2.4) — so the rule
   * answers null until something tells it, rather than picking an item on the player's behalf.
   */
  readonly target?: { readonly id: ItemId; readonly cost: number };
}

export function createGoldUntilItemRule(
  opts: GoldUntilItemOptions = {},
): DerivedRule<GoldUntilItem> {
  return {
    id: DERIVED_IDS.goldUntilItem,
    dependsOn: [GOLD_PATH, GPM_PATH],
    compute(state, now, clock): Fact<GoldUntilItem> | null {
      const target = opts.target;
      const gold = state.self.gold;
      if (target === undefined || gold === undefined) return null;

      const have = gold.value.reliable + gold.value.unreliable;
      const remaining = Math.max(0, target.cost - have);
      const gpm = state.self.gpm;
      const inputs = gpm === undefined ? [gold] : [gold, gpm];
      const etaSeconds =
        remaining === 0
          ? 0
          : gpm === undefined || gpm.value <= 0
            ? null
            : (remaining / gpm.value) * 60;

      return derivedFact<GoldUntilItem>(
        { item: target.id, cost: target.cost, have, remaining, etaSeconds },
        { observedAt: now, atGameClock: clock },
        inputs,
      );
    },
  };
}

export interface BuybackAffordable {
  readonly affordable: boolean;
  readonly cost: number;
  /** Buyback spends reliable *and* unreliable gold, so this is the total. */
  readonly have: number;
  readonly shortBy: number;
  /** Affordability is not availability: the cooldown can rule it out with the gold in hand. */
  readonly cooldownReady: boolean;
  readonly cooldownSeconds: number;
}

export function createBuybackAffordableRule(): DerivedRule<BuybackAffordable> {
  return {
    id: DERIVED_IDS.buybackAffordable,
    dependsOn: [GOLD_PATH, BUYBACK_PATH],
    compute(state, now, clock): Fact<BuybackAffordable> | null {
      const gold = state.self.gold;
      const buyback = state.self.buyback;
      if (gold === undefined || buyback === undefined) return null;

      const have = gold.value.reliable + gold.value.unreliable;
      const cost = buyback.value.cost;
      const cooldownSeconds = buyback.value.cooldown;

      return derivedFact<BuybackAffordable>(
        {
          affordable: have >= cost,
          cost,
          have,
          shortBy: Math.max(0, cost - have),
          cooldownReady: cooldownSeconds <= 0,
          cooldownSeconds,
        },
        { observedAt: now, atGameClock: clock },
        [gold, buyback],
      );
    },
  };
}

export interface NetWorthLead {
  /** Positive means the player's team is ahead. */
  readonly lead: number;
  readonly ours: number;
  readonly theirs: number;
}

/**
 * Answers only when **all ten** net worths are known, which in practice means the scoreboard has
 * been open. That is deliberate: a lead computed from six known values and four missing ones is
 * not a smaller lead, it is a wrong one — and it would be wrong in whichever direction the
 * missing heroes happened to fall, which is worse than silence in a voice product.
 */
export function createNetWorthLeadRule(): DerivedRule<NetWorthLead> {
  return {
    id: DERIVED_IDS.netWorthLead,
    dependsOn: [NET_WORTH_PATH, fieldPath('enemies', '*', 'netWorth')],
    compute(state, now, clock): Fact<NetWorthLead> | null {
      const self = state.self.netWorth;
      if (self === undefined) return null;
      if (state.allies.size < 4 || state.enemies.size < 5) return null;

      const inputs: Fact<unknown>[] = [self];
      let ours = self.value;
      for (const ally of state.allies.values()) {
        if (ally.netWorth === undefined) return null;
        ours += ally.netWorth.value;
        inputs.push(ally.netWorth);
      }

      let theirs = 0;
      for (const enemy of state.enemies.values()) {
        if (enemy.netWorth === undefined) return null;
        theirs += enemy.netWorth.value;
        inputs.push(enemy.netWorth);
      }

      return derivedFact<NetWorthLead>(
        { lead: ours - theirs, ours, theirs },
        { observedAt: now, atGameClock: clock },
        inputs,
      );
    },
  };
}

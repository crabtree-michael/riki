/**
 * The default rule set.
 *
 * Assembled here rather than inside `createDerivedRegistry` so that the registry stays a
 * container and a test can construct one with a single rule in it. Two of the eight need
 * something the model cannot supply — a build target and an XP table — and both degrade to null
 * or to a weaker answer rather than guessing (see their files).
 */

import type { StalenessPolicy } from '../../fusion/staleness.js';
import { createStalenessPolicy } from '../../fusion/staleness.js';
import type { DerivedRule } from '../registry.js';
import type { GoldUntilItemOptions } from './economy.js';
import {
  createBuybackAffordableRule,
  createGoldUntilItemRule,
  createNetWorthLeadRule,
} from './economy.js';
import type { PowerSpikeOptions } from './power-spike.js';
import { createPowerSpikeRule } from './power-spike.js';
import { createRoshanWindowRule, createRuneTimingsRule, createStackTimingRule } from './timings.js';
import type { UnseenEnemiesOptions } from './unseen-enemies.js';
import { createUnseenEnemiesRule } from './unseen-enemies.js';

export interface DefaultRuleOptions {
  readonly staleness?: StalenessPolicy;
  readonly goldUntilItem?: GoldUntilItemOptions;
  readonly powerSpike?: PowerSpikeOptions;
  readonly unseenEnemies?: Omit<UnseenEnemiesOptions, 'staleness'>;
}

export function defaultDerivedRules(
  opts: DefaultRuleOptions = {},
): readonly DerivedRule<unknown>[] {
  const staleness = opts.staleness ?? createStalenessPolicy();

  return [
    createGoldUntilItemRule(opts.goldUntilItem),
    createBuybackAffordableRule(),
    createNetWorthLeadRule(),
    createPowerSpikeRule(opts.powerSpike),
    createRuneTimingsRule(),
    createStackTimingRule(),
    createRoshanWindowRule(),
    createUnseenEnemiesRule({ ...opts.unseenEnemies, staleness }),
  ] as readonly DerivedRule<unknown>[];
}

export * from './economy.js';
export * from './power-spike.js';
export * from './timings.js';
export * from './unseen-enemies.js';

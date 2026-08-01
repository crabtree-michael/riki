/**
 * Tier 1, one describe per rule. §10 asks each for two things: inputs → expected value, and
 * inputs-too-stale-or-missing → `null`. The second is the one that matters — "you can afford
 * buyback", computed from forty-second-old gold, is worse than no answer.
 */

import { describe, expect, it } from 'vitest';
import { gsiFact } from '../../fact.js';
import { createStalenessPolicy } from '../../fusion/staleness.js';
import type { HeroId, ItemId, WorldState } from '../../state.js';
import { emptyState, writeFact, fieldPath, heroField } from '../../state.js';
import { asGameClock, asMonoMs, asSeconds } from '../../time.js';
import {
  createBuybackAffordableRule,
  createGoldUntilItemRule,
  createNetWorthLeadRule,
} from './economy.js';
import { createPowerSpikeRule } from './power-spike.js';
import { createRoshanWindowRule, createRuneTimingsRule, createStackTimingRule } from './timings.js';
import { createUnseenEnemiesRule } from './unseen-enemies.js';

const NOW = asMonoMs(10_000);

/** Builds a state with some GSI facts stamped at one moment. */
function stateWith(
  entries: readonly (readonly [string, unknown])[],
  atGameClock: number | null = 600,
): WorldState {
  const at = {
    observedAt: NOW,
    atGameClock: atGameClock === null ? null : asGameClock(atGameClock),
  };
  return entries.reduce<WorldState>(
    (state, [path, value]) => writeFact(state, fieldPath(path), gsiFact(value, at)),
    emptyState(asMonoMs(0)),
  );
}

const clock = asGameClock(600);

describe('goldUntilItem', () => {
  const gold = ['self.gold', { reliable: 320, unreliable: 1520 }] as const;

  it('answers null with no target, rather than picking an item for the player', () => {
    const rule = createGoldUntilItemRule();
    expect(rule.compute(stateWith([gold, ['self.gpm', 512]]), NOW, clock)).toBeNull();
  });

  it('pre-computes the arithmetic dota2 §6.2 does not want the model doing', () => {
    const rule = createGoldUntilItemRule({ target: { id: 'diffusal' as ItemId, cost: 2500 } });
    const fact = rule.compute(stateWith([gold, ['self.gpm', 600]]), NOW, clock);

    expect(fact?.value.remaining).toBe(660);
    expect(fact?.value.etaSeconds).toBeCloseTo(66, 5);
  });

  it('refuses an ETA at zero GPM instead of answering "in ∞ seconds"', () => {
    const rule = createGoldUntilItemRule({ target: { id: 'diffusal' as ItemId, cost: 2500 } });
    const fact = rule.compute(stateWith([gold, ['self.gpm', 0]]), NOW, clock);
    expect(fact?.value.etaSeconds).toBeNull();
    expect(fact?.value.remaining).toBe(660);
  });
});

describe('buybackAffordable', () => {
  const rule = createBuybackAffordableRule();

  it('spends both gold pools, because buyback does', () => {
    const fact = rule.compute(
      stateWith([
        ['self.gold', { reliable: 900, unreliable: 800 }],
        ['self.buyback', { cost: 1600, cooldown: asSeconds(0) }],
      ]),
      NOW,
      clock,
    );
    expect(fact?.value.affordable).toBe(true);
    expect(fact?.value.shortBy).toBe(0);
    expect(fact?.value.cooldownReady).toBe(true);
  });

  it('separates affordability from availability', () => {
    const fact = rule.compute(
      stateWith([
        ['self.gold', { reliable: 2000, unreliable: 0 }],
        ['self.buyback', { cost: 1600, cooldown: asSeconds(180) }],
      ]),
      NOW,
      clock,
    );
    expect(fact?.value.affordable).toBe(true);
    expect(fact?.value.cooldownReady).toBe(false);
  });

  it('answers null when either input has never been observed', () => {
    expect(
      rule.compute(stateWith([['self.gold', { reliable: 0, unreliable: 0 }]]), NOW, clock),
    ).toBeNull();
  });
});

describe('netWorthLead', () => {
  const rule = createNetWorthLeadRule();

  it('answers null until all ten are known', () => {
    // A lead from six known values is not a smaller lead, it is a wrong one.
    const partial = stateWith([
      ['self.netWorth', 7200],
      ['enemies.a.netWorth', 6000],
      ['enemies.b.netWorth', 6000],
    ]);
    expect(rule.compute(partial, NOW, clock)).toBeNull();
  });

  it('sums both teams once every net worth has landed', () => {
    const entries: (readonly [string, unknown])[] = [['self.netWorth', 7200]];
    for (const hero of ['a', 'b', 'c', 'd']) entries.push([`allies.${hero}.netWorth`, 5000]);
    for (const hero of ['v', 'w', 'x', 'y', 'z']) entries.push([`enemies.${hero}.netWorth`, 4800]);

    const fact = rule.compute(stateWith(entries), NOW, clock);
    expect(fact?.value.ours).toBe(27_200);
    expect(fact?.value.theirs).toBe(24_000);
    expect(fact?.value.lead).toBe(3_200);
  });
});

describe('powerSpikeIn', () => {
  it('names the next spike and why it is one', () => {
    const fact = createPowerSpikeRule().compute(stateWith([['self.level', 11]]), NOW, clock);
    expect(fact?.value.nextSpikeLevel).toBe(12);
    expect(fact?.value.reason).toBe('ultimate');
    expect(fact?.value.levelsAway).toBe(1);
  });

  it('leaves the ETA null without an XP table rather than inventing a countdown', () => {
    // The table is patch-versioned and unverified; a wrong countdown looks exactly as
    // authoritative as a right one, which is the failure dota2 §9 forbids.
    const fact = createPowerSpikeRule().compute(
      stateWith([
        ['self.level', 11],
        ['self.xp', 6800],
        ['self.xpm', 500],
      ]),
      NOW,
      clock,
    );
    expect(fact?.value.etaSeconds).toBeNull();
  });

  it('computes the ETA once someone supplies a verified table', () => {
    const xpToLevel: number[] = [];
    xpToLevel[12] = 7_800;
    const fact = createPowerSpikeRule({ xpToLevel }).compute(
      stateWith([
        ['self.level', 11],
        ['self.xp', 6_800],
        ['self.xpm', 600],
      ]),
      NOW,
      clock,
    );
    expect(fact?.value.etaSeconds).toBeCloseTo(100, 5);
  });

  it('answers null at level 25, where there is nothing left to spike to', () => {
    expect(createPowerSpikeRule().compute(stateWith([['self.level', 25]]), NOW, clock)).toBeNull();
  });
});

describe('clock-only rules', () => {
  it('finds the next rune of each kind', () => {
    const state = stateWith([['meta.clock', asGameClock(530)]], 530);
    const fact = createRuneTimingsRule().compute(state, NOW, asGameClock(530));

    expect(fact?.value.nextBountyAt).toBe(540);
    expect(fact?.value.nextPowerAt).toBe(600);
    expect(fact?.value.nextWaterAt).toBeNull(); // Water runes are gone after 4:00.
  });

  it('counts down to the next stack pull', () => {
    const state = stateWith([['meta.clock', asGameClock(645)]], 645);
    const fact = createStackTimingRule().compute(state, NOW, asGameClock(645));
    expect(fact?.value.nextStackIn).toBe(8);
    expect(fact?.value.nextStackAt).toBe(653);
  });

  it('gives no timing at all before the horn', () => {
    // A negative clock is pre-game; treating it as second zero would produce timings for a match
    // that has not started.
    const state = stateWith([['meta.clock', asGameClock(-30)]], -30);
    expect(createRuneTimingsRule().compute(state, NOW, asGameClock(-30))).toBeNull();
  });

  it('gives a Roshan window only from a death whose time we actually know', () => {
    const rule = createRoshanWindowRule();
    const at = { observedAt: NOW, atGameClock: asGameClock(1200) };

    const known = writeFact(
      stateWith([['meta.clock', asGameClock(1500)]], 1500),
      fieldPath('map', 'roshanState'),
      gsiFact('dead', at),
    );
    const fact = rule.compute(known, NOW, asGameClock(1500));
    expect(fact?.value.opensAt).toBe(1680);
    expect(fact?.value.closesAt).toBe(1860);
    expect(fact?.value.maybeUp).toBe(false);

    const unclocked = writeFact(
      stateWith([['meta.clock', asGameClock(1500)]], 1500),
      fieldPath('map', 'roshanState'),
      gsiFact('dead', { observedAt: NOW, atGameClock: null }),
    );
    expect(rule.compute(unclocked, NOW, asGameClock(1500))).toBeNull();
  });
});

describe('unseenEnemies', () => {
  const rule = createUnseenEnemiesRule({ staleness: createStalenessPolicy() });
  const sf = 'nevermore' as HeroId;

  it('reports a hero never seen as unknown, with a null age', () => {
    const state = writeFact(
      emptyState(asMonoMs(0)),
      heroField('enemies', sf, 'level'),
      gsiFact(10, { observedAt: NOW, atGameClock: clock }),
    );
    const fact = rule.compute(state, NOW, clock);
    expect(fact?.value).toEqual([{ hero: sf, ageMs: null, lastSeenAt: null }]);
  });

  it('leaves a freshly seen hero out of the list', () => {
    const at = { observedAt: NOW, atGameClock: asGameClock(600) };
    const state = writeFact(
      emptyState(asMonoMs(0)),
      heroField('enemies', sf, 'position'),
      gsiFact({ x: 1, y: 2 }, at),
    );
    expect(rule.compute(state, NOW, asGameClock(601))?.value).toEqual([]);
  });

  it('reports one whose position has aged past the threshold, with the last-seen hypothesis', () => {
    const at = { observedAt: NOW, atGameClock: asGameClock(600) };
    let state = writeFact(
      emptyState(asMonoMs(0)),
      heroField('enemies', sf, 'position'),
      gsiFact({ x: 1, y: 2 }, at),
    );
    state = writeFact(state, heroField('enemies', sf, 'lastSeenAt'), gsiFact({ x: 1, y: 2 }, at));

    const fact = rule.compute(state, NOW, asGameClock(630));
    expect(fact?.value).toEqual([{ hero: sf, ageMs: 30_000, lastSeenAt: { x: 1, y: 2 } }]);
  });
});

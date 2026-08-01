/**
 * One block per detector, and every block asserts the same three things: it fires on its condition,
 * it does **not** fire on the near miss, and it emits nothing when the fact it needs is absent.
 *
 * The third is the one worth writing every time. Six of the eight can be starved of their input —
 * no CV sidecar, no build target, no scoreboard — and "emits nothing" is the designed behaviour in
 * every case (coaching-trigger-architecture.md §3.2). A detector that guesses instead is the
 * failure dota2 §4 rule 3 is about, and it is invisible until somebody walks into four people.
 */

import { describe, expect, it } from 'vitest';
import type { AbilityState, FieldPath, HeroId, ItemState, MapPosition } from '@riki/world-model';
import { fieldPath, heroField } from '@riki/world-model';
import { DEFAULT_TRIGGER_CONFIG as CFG } from '../config.js';
import { enemyCoreDeadWindow, lowHpNoEscape, ultReady } from './combat.js';
import { buybackUnaffordable, canAffordKeyItem } from './economy.js';
import { enemyMissing } from './map.js';
import { runeSoon, stackNow } from './timings.js';
import { buildWorld } from '../testing/index.js';

const SF = 'sf' as HeroId;
const CM = 'cm' as HeroId;
const SELF_HEALTH: FieldPath = fieldPath('self', 'health');
const SELF_ALIVE: FieldPath = fieldPath('self', 'alive');
const SELF_POSITION: FieldPath = fieldPath('self', 'position');
const SELF_ABILITIES: FieldPath = fieldPath('self', 'abilities');
const SELF_ITEMS: FieldPath = fieldPath('self', 'items');
const SELF_GOLD: FieldPath = fieldPath('self', 'gold');
const SELF_BUYBACK: FieldPath = fieldPath('self', 'buyback');
const META_CLOCK: FieldPath = fieldPath('meta', 'clock');

const HERE: MapPosition = { x: 0, y: 0 };

function ability(overrides: Partial<AbilityState> = {}): AbilityState {
  return {
    id: 'requiem',
    level: 3,
    cooldown: 0,
    castable: true,
    isUltimate: true,
    ...overrides,
  } as AbilityState;
}

function item(overrides: Partial<ItemState> = {}): ItemState {
  return {
    id: 'item_blink',
    slot: 0,
    location: 'inventory',
    charges: undefined,
    cooldown: 0,
    castable: true,
    ...overrides,
  } as ItemState;
}

// -------------------------------------------------------------------------------------------------
// enemy_missing
// -------------------------------------------------------------------------------------------------

describe('enemy_missing', () => {
  /** Five enemies with positions; the named ones are aged past the threshold. */
  function withEnemies(missing: readonly HeroId[], ageSeconds: number) {
    const world = buildWorld();
    const roster = [SF, CM, 'zeus' as HeroId, 'ws' as HeroId, 'lion' as HeroId];
    for (const hero of roster) {
      const age = missing.includes(hero) ? ageSeconds : 0;
      world.put(heroField('enemies', hero, 'position'), HERE, { ageSeconds: age });
    }
    return world;
  }

  it('fires for a hero unseen past the threshold, and scales with age', () => {
    const short = enemyMissing.detect(withEnemies([SF], 26).snapshot(), CFG);
    const long = enemyMissing.detect(withEnemies([SF], 44).snapshot(), CFG);

    expect(short).toHaveLength(1);
    expect(short[0]?.topic).toEqual({ of: 'hero', hero: SF });
    // coaching-architecture.md §6.2's own example: 40 s must outrank 21 s.
    expect(long[0]?.magnitude).toBeGreaterThan(short[0]?.magnitude ?? 1);
  });

  it('does not fire below the threshold', () => {
    expect(enemyMissing.detect(withEnemies([SF], 10).snapshot(), CFG)).toHaveLength(0);
  });

  it('ranks three missing above one, immediately', () => {
    const one = enemyMissing.detect(withEnemies([SF], 26).snapshot(), CFG);
    const three = enemyMissing.detect(withEnemies([SF, CM, 'zeus' as HeroId], 26).snapshot(), CFG);

    expect(three).toHaveLength(3);
    expect(three[0]?.magnitude).toBeGreaterThan(one[0]?.magnitude ?? 1);
  });

  it('does not fire for a hero known to be dead — that is the other detector', () => {
    const world = withEnemies([SF], 40).put(heroField('enemies', SF, 'alive'), false);
    expect(enemyMissing.detect(world.snapshot(), CFG)).toHaveLength(0);
  });

  it('emits nothing when nothing has ever seen a position — the no-sidecar case', () => {
    const world = buildWorld().put(heroField('enemies', SF, 'hero'), SF);
    expect(enemyMissing.detect(world.snapshot(), CFG)).toHaveLength(0);
  });

  it('carries CV confidence through rather than dropping it', () => {
    const world = buildWorld();
    world.put(heroField('enemies', SF, 'position'), HERE, { ageSeconds: 40, confidence: 0.55 });
    expect(enemyMissing.detect(world.snapshot(), CFG)[0]?.confidence).toBeCloseTo(0.55);
  });
});

// -------------------------------------------------------------------------------------------------
// low_hp_no_escape
// -------------------------------------------------------------------------------------------------

describe('low_hp_no_escape', () => {
  function inDanger(hpFraction: number, items: readonly ItemState[] = []) {
    return buildWorld()
      .put(SELF_ALIVE, true)
      .put(SELF_POSITION, HERE)
      .put(SELF_HEALTH, { current: hpFraction * 1000, max: 1000 })
      .put(SELF_ITEMS, items)
      .put(heroField('enemies', SF, 'position'), HERE);
  }

  it('fires when low, threatened and without an escape', () => {
    const found = lowHpNoEscape.detect(inDanger(0.2).snapshot(), CFG);
    expect(found).toHaveLength(1);
    expect(found[0]?.actWithinSeconds).toBe(CFG.lowHpActWithinSeconds);
  });

  it('does not fire at healthy hp', () => {
    expect(lowHpNoEscape.detect(inDanger(0.8).snapshot(), CFG)).toHaveLength(0);
  });

  it('does not fire with nobody nearby — low in the fountain is not danger', () => {
    const world = buildWorld()
      .put(SELF_ALIVE, true)
      .put(SELF_POSITION, HERE)
      .put(SELF_HEALTH, { current: 200, max: 1000 });
    expect(lowHpNoEscape.detect(world.snapshot(), CFG)).toHaveLength(0);
  });

  it('does not fire with a castable escape in the bag', () => {
    expect(lowHpNoEscape.detect(inDanger(0.2, [item()]).snapshot(), CFG)).toHaveLength(0);
  });

  it('fires when the escape is on cooldown, or in the stash', () => {
    expect(
      lowHpNoEscape.detect(inDanger(0.2, [item({ castable: false })]).snapshot(), CFG),
    ).toHaveLength(1);
    expect(
      lowHpNoEscape.detect(inDanger(0.2, [item({ location: 'stash' })]).snapshot(), CFG),
    ).toHaveLength(1);
  });

  it('does not fire when dead', () => {
    const world = inDanger(0.2).put(SELF_ALIVE, false);
    expect(lowHpNoEscape.detect(world.snapshot(), CFG)).toHaveLength(0);
  });

  it('emits nothing with no health fact at all', () => {
    const world = buildWorld().put(SELF_ALIVE, true).put(SELF_POSITION, HERE);
    expect(lowHpNoEscape.detect(world.snapshot(), CFG)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// ult_ready
// -------------------------------------------------------------------------------------------------

describe('ult_ready', () => {
  function withUlt(abilities: readonly AbilityState[], enemyVisible: boolean) {
    const world = buildWorld().put(SELF_ALIVE, true).put(SELF_ABILITIES, abilities);
    if (enemyVisible) world.put(heroField('enemies', SF, 'position'), HERE);
    return world;
  }

  it('fires when the ult is up and an enemy is visible', () => {
    expect(ultReady.detect(withUlt([ability()], true).snapshot(), CFG)).toHaveLength(1);
  });

  it('is silent with nobody in sight — the alarm-clock case §3.2 exists for', () => {
    expect(ultReady.detect(withUlt([ability()], false).snapshot(), CFG)).toHaveLength(0);
  });

  it('does not fire on an unlearned or uncastable ultimate', () => {
    expect(ultReady.detect(withUlt([ability({ level: 0 })], true).snapshot(), CFG)).toHaveLength(0);
    expect(
      ultReady.detect(withUlt([ability({ castable: false })], true).snapshot(), CFG),
    ).toHaveLength(0);
  });

  it('ignores a castable non-ultimate', () => {
    expect(
      ultReady.detect(withUlt([ability({ isUltimate: false })], true).snapshot(), CFG),
    ).toHaveLength(0);
  });

  it('is silent when an enemy position has gone stale', () => {
    const world = buildWorld()
      .put(SELF_ALIVE, true)
      .put(SELF_ABILITIES, [ability()])
      .put(heroField('enemies', SF, 'position'), HERE, { ageSeconds: 30 });
    expect(ultReady.detect(world.snapshot(), CFG)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// enemy_core_dead_window
// -------------------------------------------------------------------------------------------------

describe('enemy_core_dead_window', () => {
  function dead(respawnIn: number) {
    return buildWorld()
      .put(heroField('enemies', SF, 'alive'), false)
      .put(heroField('enemies', SF, 'respawnIn'), respawnIn);
  }

  it('fires on a long respawn, and the window length is its magnitude', () => {
    const shortWindow = enemyCoreDeadWindow.detect(dead(30).snapshot(), CFG);
    const longWindow = enemyCoreDeadWindow.detect(dead(58).snapshot(), CFG);

    expect(shortWindow).toHaveLength(1);
    expect(longWindow[0]?.magnitude).toBeGreaterThan(shortWindow[0]?.magnitude ?? 1);
    // Not a deadline: §3.2's inversion, and the reason the urgency curve does not cancel it out.
    expect(longWindow[0]?.actWithinSeconds).toBeNull();
  });

  it('does not fire on a short respawn', () => {
    expect(enemyCoreDeadWindow.detect(dead(10).snapshot(), CFG)).toHaveLength(0);
  });

  it('does not fire for a living enemy', () => {
    const world = buildWorld()
      .put(heroField('enemies', SF, 'alive'), true)
      .put(heroField('enemies', SF, 'respawnIn'), 60);
    expect(enemyCoreDeadWindow.detect(world.snapshot(), CFG)).toHaveLength(0);
  });

  it('emits nothing without a scoreboard reading', () => {
    const world = buildWorld().put(heroField('enemies', SF, 'position'), HERE);
    expect(enemyCoreDeadWindow.detect(world.snapshot(), CFG)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// can_afford_key_item
// -------------------------------------------------------------------------------------------------

describe('can_afford_key_item', () => {
  const target = { id: 'item_black_king_bar' as ItemState['id'], cost: 4050 };

  it('fires once the target is affordable', () => {
    const world = buildWorld({ goldTarget: target })
      .put(SELF_GOLD, { reliable: 2000, unreliable: 2500 })
      .put(fieldPath('self', 'gpm'), 600);
    const found = canAffordKeyItem.detect(world.snapshot(), CFG);
    expect(found).toHaveLength(1);
    expect(found[0]?.topic).toEqual({ of: 'item', item: target.id });
  });

  it('does not fire while short', () => {
    const world = buildWorld({ goldTarget: target })
      .put(SELF_GOLD, { reliable: 100, unreliable: 100 })
      .put(fieldPath('self', 'gpm'), 600);
    expect(canAffordKeyItem.detect(world.snapshot(), CFG)).toHaveLength(0);
  });

  it('is dark with no build target — §3.3, and it is the one silence that means "unwired"', () => {
    const world = buildWorld()
      .put(SELF_GOLD, { reliable: 9000, unreliable: 9000 })
      .put(fieldPath('self', 'gpm'), 600);
    expect(canAffordKeyItem.detect(world.snapshot(), CFG)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// buyback_unaffordable
// -------------------------------------------------------------------------------------------------

describe('buyback_unaffordable', () => {
  function shortBy(gold: number, cost: number) {
    return buildWorld()
      .put(SELF_ALIVE, true)
      .put(SELF_GOLD, { reliable: gold, unreliable: 0 })
      .put(SELF_BUYBACK, { cost, cooldown: 0 });
  }

  it('fires when close, and being closer is more salient', () => {
    const near = buybackUnaffordable.detect(shortBy(1800, 2000).snapshot(), CFG);
    const far = buybackUnaffordable.detect(shortBy(700, 2000).snapshot(), CFG);

    expect(near).toHaveLength(1);
    expect(near[0]?.magnitude).toBeGreaterThan(far[0]?.magnitude ?? 1);
  });

  it('does not fire when the shortfall is hopeless', () => {
    expect(buybackUnaffordable.detect(shortBy(0, 4000).snapshot(), CFG)).toHaveLength(0);
  });

  it('does not fire when buyback is affordable', () => {
    expect(buybackUnaffordable.detect(shortBy(3000, 2000).snapshot(), CFG)).toHaveLength(0);
  });

  it('emits nothing without a buyback fact', () => {
    const world = buildWorld().put(SELF_ALIVE, true).put(SELF_GOLD, { reliable: 0, unreliable: 0 });
    expect(buybackUnaffordable.detect(world.snapshot(), CFG)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// rune_soon and stack_now
// -------------------------------------------------------------------------------------------------

describe('rune_soon', () => {
  /** Power runes are every two minutes from 6:00, so 9:50 is ten seconds out. */
  it('fires inside the lead time, with the remaining seconds as its deadline', () => {
    const world = buildWorld({ clock: 590 }).put(META_CLOCK, 590);
    const found = runeSoon.detect(world.snapshot(), CFG);

    expect(found).toHaveLength(1);
    expect(found[0]?.topic).toEqual({ of: 'objective', objective: 'rune' });
    expect(found[0]?.actWithinSeconds).toBeLessThanOrEqual(CFG.runeLeadSeconds);
  });

  it('does not fire when the next rune is far away', () => {
    const world = buildWorld({ clock: 500 }).put(META_CLOCK, 500);
    expect(runeSoon.detect(world.snapshot(), CFG)).toHaveLength(0);
  });

  it('gives each rune its own key, so the latch clears between them', () => {
    const first = runeSoon.detect(buildWorld({ clock: 590 }).put(META_CLOCK, 590).snapshot(), CFG);
    const second = runeSoon.detect(buildWorld({ clock: 710 }).put(META_CLOCK, 710).snapshot(), CFG);
    expect(first[0]?.key).not.toBe(second[0]?.key);
  });

  it('emits nothing before the horn', () => {
    const world = buildWorld({ clock: null });
    expect(runeSoon.detect(world.snapshot(), CFG)).toHaveLength(0);
  });
});

describe('stack_now', () => {
  it('fires in the seconds before :53', () => {
    const world = buildWorld({ clock: 648 }).put(META_CLOCK, 648);
    const found = stackNow.detect(world.snapshot(), CFG);
    expect(found).toHaveLength(1);
    expect(found[0]?.actWithinSeconds).toBe(5);
  });

  it('does not fire just after the stack second', () => {
    const world = buildWorld({ clock: 655 }).put(META_CLOCK, 655);
    expect(stackNow.detect(world.snapshot(), CFG)).toHaveLength(0);
  });

  it('emits nothing before the horn', () => {
    expect(stackNow.detect(buildWorld({ clock: null }).snapshot(), CFG)).toHaveLength(0);
  });
});

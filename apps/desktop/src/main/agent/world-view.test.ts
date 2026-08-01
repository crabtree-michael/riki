/**
 * The adapter's one rule, asserted from both directions.
 *
 * > This adapter renames and reshapes. It does not compute anything the world model could not
 * > already answer.
 *
 * So the tests come in pairs: a projection carries its source's envelope through unchanged, and a
 * path that would need game arithmetic answers `undefined` rather than a number with no provenance
 * behind it. The second half looks like missing coverage and is the design — an unsatisfied path is
 * an omitted section, recorded in `CoachingBrief.omitted`, and coaching-trigger-architecture.md §15
 * names each one as `packages/world-model`'s work.
 */

import { describe, expect, it } from 'vitest';
import type { FieldPath as ContextFieldPath } from '@riki/context';
import type { FieldPath, HeroId, ItemState, MapPosition } from '@riki/world-model';
import { createStalenessPolicy, fieldPath, heroField } from '@riki/world-model';
import { buildWorld } from '@riki/events/testing';
import { toContextReader, toContextSnapshot } from './world-view.js';

const SELF_HEALTH: FieldPath = fieldPath('self', 'health');
const SELF_MANA: FieldPath = fieldPath('self', 'mana');
const SELF_GOLD: FieldPath = fieldPath('self', 'gold');
const SELF_ITEMS: FieldPath = fieldPath('self', 'items');
const SELF_LEVEL: FieldPath = fieldPath('self', 'level');
const META_CLOCK: FieldPath = fieldPath('meta', 'clock');
const META_TEAM: FieldPath = fieldPath('meta', 'team');
const MAP_BUILDINGS: FieldPath = fieldPath('map', 'buildings');

const SF = 'sf' as HeroId;
const HERE: MapPosition = { x: 0, y: 0 };

function at(path: string): ContextFieldPath {
  return path as ContextFieldPath;
}

function item(id: string, location: ItemState['location']): ItemState {
  return { id, slot: 0, location, charges: undefined, cooldown: 0, castable: true } as ItemState;
}

function viewOf(world: ReturnType<typeof buildWorld>) {
  return toContextSnapshot(world.snapshot(), createStalenessPolicy());
}

describe('direct reads', () => {
  it('collapses a StaleFact into an Observed without losing anything', () => {
    const world = buildWorld().put(SELF_LEVEL, 12, { ageSeconds: 3, confidence: 0.6 });
    const observed = viewOf(world).get<number>(at('self.level'));

    expect(observed?.value).toBe(12);
    expect(observed?.confidence).toBeCloseTo(0.6);
    expect(observed?.source).toBe('cv');
    expect(observed?.ageMs).toBe(3_000);
    expect(observed?.staleness).toBe('aging');
  });

  it('answers undefined for a field the model has never observed', () => {
    expect(viewOf(buildWorld()).get(at('self.level'))).toBeUndefined();
  });

  it('answers undefined for a path the world model does not declare at all', () => {
    expect(viewOf(buildWorld()).get(at('self.notAField'))).toBeUndefined();
  });
});

describe('projections keep the envelope', () => {
  it('turns health into a percentage and carries the fact through', () => {
    const world = buildWorld().put(
      SELF_HEALTH,
      { current: 220, max: 1000 },
      {
        ageSeconds: 2,
        confidence: 0.8,
      },
    );
    const observed = viewOf(world).get<number>(at('self.hpPct'));

    expect(observed?.value).toBe(22);
    expect(observed?.confidence).toBeCloseTo(0.8);
    expect(observed?.ageMs).toBe(2_000);
  });

  it('does the same for mana', () => {
    const world = buildWorld().put(SELF_MANA, { current: 400, max: 1000 });
    expect(viewOf(world).get<number>(at('self.mpPct'))?.value).toBe(40);
  });

  it('refuses a percentage of a zero maximum rather than dividing by it', () => {
    const world = buildWorld().put(SELF_HEALTH, { current: 0, max: 0 });
    expect(viewOf(world).get(at('self.hpPct'))).toBeUndefined();
  });

  it('splits gold into a total and its reliable half from one fact', () => {
    const world = buildWorld().put(SELF_GOLD, { reliable: 900, unreliable: 350 });
    const view = viewOf(world);

    expect(view.get<number>(at('self.gold'))?.value).toBe(1_250);
    expect(view.get<number>(at('self.goldReliable'))?.value).toBe(900);
  });

  it('separates the inventory from the stash, and counts free slots', () => {
    const world = buildWorld().put(SELF_ITEMS, [
      item('item_blink', 'inventory'),
      item('item_bkb', 'inventory'),
      item('item_ward', 'stash'),
    ]);
    const view = viewOf(world);

    expect(view.get<readonly ItemState[]>(at('self.items'))?.value).toHaveLength(2);
    expect(view.get<readonly ItemState[]>(at('self.stash'))?.value).toHaveLength(1);
    expect(view.get<number>(at('self.freeSlots'))?.value).toBe(4);
  });

  it('inherits the source field’s ageing policy, not the fallback', () => {
    // `self.*` is fresh under 1.5 s. If `self.hpPct` were classified against its own name it would
    // fall through to the default table and get a different threshold.
    const world = buildWorld().put(SELF_HEALTH, { current: 500, max: 1000 }, { ageSeconds: 3 });
    expect(viewOf(world).get(at('self.hpPct'))?.staleness).toBe('aging');
  });
});

describe('the one projection that reads two facts', () => {
  const buildings = {
    towers: { radiant_top_1: 1600, dire_mid_1: 0 },
    barracks: { radiant_top_melee: 2200 },
    ancient: { radiant: 4500, dire: 4500 },
  };

  it('re-labels radiant/dire as us/them using the player’s team', () => {
    const world = buildWorld().put(MAP_BUILDINGS, buildings).put(META_TEAM, 'radiant');
    const towers = viewOf(world).get<readonly { id: string; side: string; down: boolean }[]>(
      at('map.towers'),
    );

    expect(towers?.value).toEqual([
      { id: 'radiant_top_1', side: 'us', down: false },
      { id: 'dire_mid_1', side: 'them', down: true },
    ]);
  });

  it('answers nothing without a team, rather than guessing which half of the map is ours', () => {
    const world = buildWorld().put(MAP_BUILDINGS, buildings);
    expect(viewOf(world).get(at('map.towers'))).toBeUndefined();
  });

  it('carries the minimum confidence of its two inputs', () => {
    const world = buildWorld()
      .put(MAP_BUILDINGS, buildings, { confidence: 0.5 })
      .put(META_TEAM, 'radiant');
    expect(viewOf(world).get(at('map.towers'))?.confidence).toBeCloseTo(0.5);
  });
});

describe('derived state, selected down to the field the renderers name', () => {
  it('takes the soonest rune of any type', () => {
    const world = buildWorld({ clock: 590 }).put(META_CLOCK, 590);
    // Power runes are every two minutes from 6:00, so 10:00 is the next one at 590.
    expect(viewOf(world).get<number>(at('derived.nextRuneAt'))?.value).toBe(600);
  });

  it('reads the next stack second', () => {
    const world = buildWorld({ clock: 600 }).put(META_CLOCK, 600);
    expect(viewOf(world).get<number>(at('derived.nextStackAt'))?.value).toBe(653);
  });

  it('gives the buyback cost from the affordability rule', () => {
    const world = buildWorld()
      .put(SELF_GOLD, { reliable: 100, unreliable: 0 })
      .put(fieldPath('self', 'buyback'), { cost: 1_900, cooldown: 0 });
    expect(viewOf(world).get<number>(at('derived.buybackCost'))?.value).toBe(1_900);
  });

  it('answers nothing for the next item when its ETA is unknowable', () => {
    // A null `etaSeconds` means GPM is zero or unknown. A `nextItem` with no time on it reads as
    // imminent, which is the opposite of what it means.
    const world = buildWorld({ goldTarget: { id: 'item_bkb' as never, cost: 4_050 } }).put(
      SELF_GOLD,
      { reliable: 100, unreliable: 0 },
    );
    expect(viewOf(world).get(at('derived.nextItem'))).toBeUndefined();
  });

  it('gives the next item once there is a GPM to divide by', () => {
    const world = buildWorld({ goldTarget: { id: 'item_bkb' as never, cost: 4_050 } })
      .put(SELF_GOLD, { reliable: 1_050, unreliable: 0 })
      .put(fieldPath('self', 'gpm'), 600);
    const next = viewOf(world).get<{ item: string; inSeconds: number }>(at('derived.nextItem'));

    expect(next?.value.item).toBe('item_bkb');
    expect(next?.value.inSeconds).toBeCloseTo(300);
  });
});

describe('what this adapter refuses to invent', () => {
  it.each([
    'derived.threats',
    'derived.paceLevel',
    'derived.paceNetWorth',
    'self.area',
    'enemies.sf.area',
  ])('%s answers undefined rather than a number with no provenance', (path) => {
    const world = buildWorld()
      .put(SELF_HEALTH, { current: 500, max: 1000 })
      .put(fieldPath('self', 'netWorth'), 12_000)
      .put(SELF_LEVEL, 16)
      .put(heroField('enemies', SF, 'position'), HERE);

    expect(viewOf(world).get(at(path))).toBeUndefined();
  });
});

describe('the rest of the read view', () => {
  it('reports the roster from the model’s own maps', () => {
    const world = buildWorld()
      .put(fieldPath('self', 'hero'), 'am')
      .put(heroField('enemies', SF, 'position'), HERE)
      .put(heroField('allies', 'cm' as HeroId, 'hero'), 'cm');

    const roster = viewOf(world).roster();
    expect(roster.self).toBe('am');
    expect(roster.enemies).toEqual([SF]);
    expect(roster.allies).toEqual(['cm']);
  });

  it('passes unseenFor through, so one threshold serves both packages', () => {
    const world = buildWorld().put(heroField('enemies', SF, 'position'), HERE, { ageSeconds: 40 });
    expect(viewOf(world).unseenFor(20)).toEqual([SF]);
  });

  it('exposes a reader whose snapshot is the adapted one', () => {
    const world = buildWorld().put(SELF_HEALTH, { current: 250, max: 1000 });
    const reader = toContextReader(world.reader());

    expect(reader.snapshot(world.now).get<number>(at('self.hpPct'))?.value).toBe(25);
  });
});

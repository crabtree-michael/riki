/**
 * Tier 1, one describe per tool, and every test does two things: assert the value, and parse the
 * whole result with the schema `packages/protocol` shows the model.
 *
 * The parse is not ceremony. These four functions exist to satisfy a contract that is enforced at
 * run time, inside a turn the model is already speaking — a projection that drifts from
 * `schemas/tools.ts` produces a tool call that fails out loud rather than a type error. `parsed`
 * below is used everywhere a result is inspected so that no assertion can pass against an object
 * the model would have rejected.
 *
 * The other obligation, from the ticket: **at least one assertion per tool that an unobserved field
 * comes back `unknown` rather than as a plausible number.** Those tests are marked with a comment
 * naming the number that would otherwise have been invented, because that number — not the missing
 * field — is what reaches a player's ear.
 */

import { describe, expect, it } from 'vitest';
import type { ToolFact, UnknownFact } from '@riki/protocol';
import {
  EconomyResult,
  EnemyResult,
  MyStateResult,
  ObjectivesResult,
  isUnknown,
} from '@riki/protocol';
import { cvFact, gsiFact, asConfidence, asDetectorId } from '../fact.js';
import { createDeltaComputer } from '../history/delta.js';
import type { HeroId, ItemId, MatchPhase, WorldState } from '../state.js';
import { emptyState, fieldPath, heroField, itemSeenField, writeFact } from '../state.js';
import { asGameClock, asMonoMs, asSeconds } from '../time.js';
import type { ToolContext } from './context.js';
import { clockString } from './context.js';
import { buildingName } from './buildings.js';
import { economy } from './economy.js';
import { enemy } from './enemy.js';
import { myState } from './my-state.js';
import { objectives } from './objectives.js';

const NOW = asMonoMs(100_000);
const CLOCK = 600;

/** Facts stamped at one moment, `ageSeconds` before `NOW`, so ages are exact rather than incidental. */
function stateWith(
  entries: readonly (readonly [string, unknown])[],
  opts: { readonly ageSeconds?: number; readonly phase?: MatchPhase } = {},
): WorldState {
  const observedAt = asMonoMs(NOW - (opts.ageSeconds ?? 0) * 1000);
  const at = { observedAt, atGameClock: asGameClock(CLOCK) };
  const base = writeFact(
    emptyState(asMonoMs(0)),
    fieldPath('meta', 'phase'),
    gsiFact<MatchPhase>(opts.phase ?? 'in_progress', at),
  );
  return entries.reduce<WorldState>(
    (state, [path, value]) => writeFact(state, fieldPath(path), gsiFact(value, at)),
    base,
  );
}

function ctxOf(state: WorldState, clock: number | null = CLOCK): ToolContext {
  return { state, now: NOW, clock: clock === null ? null : asGameClock(clock) };
}

/**
 * Parses with the schema the model is shown, then narrows past the "cannot answer at all" branch.
 *
 * The return type is inferred from the schema and has the `UnknownFact` branch excluded, so every
 * assertion below is written against `packages/protocol`'s own report types rather than a
 * hand-written shape that could agree with a wrong implementation.
 */
function parsed<T>(schema: { parse(value: unknown): T }, result: unknown): Exclude<T, UnknownFact> {
  const value = schema.parse(result);
  if (value !== null && typeof value === 'object' && 'unknown' in value) {
    throw new Error(`expected a report, got ${JSON.stringify(value)}`);
  }
  return value as Exclude<T, UnknownFact>;
}

/** The value of a fact that must be known — fails loudly rather than returning undefined. */
function value<T>(fact: ToolFact<T>): T {
  if (isUnknown(fact)) throw new Error(`expected a value, got unknown: ${fact.unknown}`);
  return fact.value;
}

const HERO = 'shadow_fiend' as HeroId;

// -----------------------------------------------------------------------------------------------
// The envelope itself
// -----------------------------------------------------------------------------------------------

describe('the fact envelope', () => {
  it('carries age, confidence and source out to the model', () => {
    const state = stateWith([['self.gold', { reliable: 320, unreliable: 1520 }]], {
      ageSeconds: 2.5,
    });
    const report = parsed(MyStateResult, myState(ctxOf(state)));
    const gold = report.gold;

    expect(isUnknown(gold)).toBe(false);
    if (isUnknown(gold)) return;
    expect(gold.age_seconds).toBeCloseTo(2.5, 5);
    expect(gold.confidence).toBe(1);
    expect(gold.source).toBe('gsi');
  });

  it('keeps a CV confidence intact rather than rounding it to certainty', () => {
    const at = { observedAt: asMonoMs(NOW - 30_000), atGameClock: asGameClock(CLOCK) };
    const state = writeFact(
      stateWith([]),
      heroField('enemies', HERO, 'lastSeenAt'),
      cvFact({ x: 4300, y: 2100 }, at, asConfidence(0.55), asDetectorId('minimap')),
    );

    const report = parsed(EnemyResult, enemy(ctxOf(state)));
    const seen = report.enemies[0]?.last_seen;
    expect(seen).toBeDefined();
    if (seen === undefined || isUnknown(seen)) throw new Error('expected a position');

    expect(seen.confidence).toBe(0.55);
    expect(seen.source).toBe('cv');
    expect(seen.age_seconds).toBeCloseTo(30, 5);
  });

  it('clamps a negative age rather than failing validation mid-sentence', () => {
    // A fact stamped in the future is a producer bug. The schema's floor is zero, and a rejected
    // tool call is a silence in a spoken answer — so it is clamped here and the value still travels.
    const state = stateWith([['self.gpm', 512]], { ageSeconds: -5 });
    const report = parsed(EconomyResult, economy(ctxOf(state)));

    expect(isUnknown(report.gpm)).toBe(false);
    if (isUnknown(report.gpm)) return;
    expect(report.gpm.age_seconds).toBe(0);
  });

  it('answers one sentence rather than eleven unknowns when there is no match', () => {
    const result = MyStateResult.parse(myState(ctxOf(stateWith([], { phase: 'idle' }))));
    expect(result).toEqual({ unknown: 'no match is in progress' });

    // And every other tool agrees, because the alternative is the model narrating an empty world.
    for (const [schema, answer] of [
      [EnemyResult, enemy(ctxOf(stateWith([], { phase: 'idle' })))],
      [ObjectivesResult, objectives(ctxOf(stateWith([], { phase: 'idle' })))],
      [EconomyResult, economy(ctxOf(stateWith([], { phase: 'idle' })))],
    ] as const) {
      expect(schema.parse(answer)).toEqual({ unknown: 'no match is in progress' });
    }
  });

  it('reports field by field during the draft, which is a match that knows very little', () => {
    // Not the same as `idle`: "you haven't picked yet" is a fact about the draft.
    const result = MyStateResult.parse(myState(ctxOf(stateWith([], { phase: 'draft' }))));
    expect(result).not.toHaveProperty('unknown');
  });
});

// -----------------------------------------------------------------------------------------------
// my_state
// -----------------------------------------------------------------------------------------------

describe('my_state', () => {
  const live = [
    ['self.hero', HERO],
    ['meta.team', 'radiant'],
    ['self.level', 16],
    ['self.alive', true],
    ['self.health', { current: 1340, max: 1868 }],
    ['self.mana', { current: 402, max: 990 }],
    ['self.gold', { reliable: 320, unreliable: 1520 }],
  ] as const;

  it('reports the hero GSI is describing', () => {
    const report = parsed(MyStateResult, myState(ctxOf(stateWith(live))));

    expect(value(report.hero)).toBe('shadow_fiend');
    expect(value(report.team)).toBe('radiant');
    expect(value(report.level)).toBe(16);
    expect(value(report.health)).toEqual({ current: 1340, max: 1868 });
  });

  it('returns unknown for health nobody observed, not zero over zero', () => {
    // The invented number this prevents: `{ current: 0, max: 0 }`, which the model reads as a hero
    // about to die and says so.
    const report = parsed(MyStateResult, myState(ctxOf(stateWith([['self.hero', HERO]]))));

    expect(report.health).toEqual({ unknown: 'never observed this match' });
    expect(report.mana).toEqual({ unknown: 'never observed this match' });
    expect(report.gold).toEqual({ unknown: 'never observed this match' });
  });

  it('projects items and abilities into the shapes the model reads', () => {
    const state = stateWith([
      ...live,
      [
        'self.items',
        [
          {
            id: 'black_king_bar' as ItemId,
            slot: 0,
            location: 'inventory',
            charges: undefined,
            cooldown: asSeconds(0),
            castable: true,
          },
          {
            id: 'tango' as ItemId,
            slot: 1,
            location: 'backpack',
            charges: 3,
            cooldown: asSeconds(0),
            castable: true,
          },
        ],
      ],
      [
        'self.abilities',
        [
          {
            id: 'nevermore_requiem',
            level: 3,
            cooldown: asSeconds(42.5),
            castable: false,
            isUltimate: true,
          },
        ],
      ],
    ]);

    const report = parsed(MyStateResult, myState(ctxOf(state)));
    const items = value(report.items) as { id: string; charges: number | null }[];
    const abilities = value(report.abilities) as { id: string; ultimate: boolean }[];

    // `charges: undefined` becomes null, because the schema has no undefined and "no charges" is a
    // fact about the item rather than a missing field.
    expect(items).toEqual([
      {
        id: 'black_king_bar',
        location: 'inventory',
        charges: null,
        cooldown_seconds: 0,
        castable: true,
      },
      { id: 'tango', location: 'backpack', charges: 3, cooldown_seconds: 0, castable: true },
    ]);
    expect(abilities[0]).toEqual({
      id: 'nevermore_requiem',
      level: 3,
      cooldown_seconds: 42.5,
      castable: false,
      ultimate: true,
    });
  });

  it('refuses buyback affordability without the gold to compute it', () => {
    // The invented number this prevents: `affordable: false` with a real-looking cost beside it.
    const state = stateWith([['self.buyback', { cost: 1420, cooldown: asSeconds(0) }]]);
    const report = parsed(MyStateResult, myState(ctxOf(state)));

    expect(report.buyback).toEqual({ unknown: 'gold or the buyback cost was never observed' });
  });

  it('inherits the older of gold and buyback, so affordability is dated by its staler input', () => {
    const old = { observedAt: asMonoMs(NOW - 40_000), atGameClock: asGameClock(CLOCK) };
    const state = writeFact(
      stateWith([['self.buyback', { cost: 1420, cooldown: asSeconds(0) }]]),
      fieldPath('self', 'gold'),
      gsiFact({ reliable: 900, unreliable: 700 }, old),
    );

    const report = parsed(MyStateResult, myState(ctxOf(state)));
    const buyback = report.buyback;
    if (isUnknown(buyback)) throw new Error('expected a buyback');

    expect(buyback.value).toEqual({ cost: 1420, cooldown_seconds: 0, affordable: true });
    expect(buyback.source).toBe('derived');
    // 40 s, not 0 — "you can buy back" is exactly as old as the gold reading behind it.
    expect(buyback.age_seconds).toBeCloseTo(40, 5);
  });
});

// -----------------------------------------------------------------------------------------------
// enemy
// -----------------------------------------------------------------------------------------------

describe('enemy', () => {
  const seen = { observedAt: asMonoMs(NOW - 30_000), atGameClock: asGameClock(CLOCK) };

  function withEnemies(heroes: readonly string[]): WorldState {
    return heroes.reduce(
      (state, hero) =>
        writeFact(
          state,
          heroField('enemies', hero as HeroId, 'lastSeenAt'),
          cvFact({ x: 4300, y: 2100 }, seen, asConfidence(0.91), asDetectorId('minimap')),
        ),
      stateWith([]),
    );
  }

  it('answers a no-argument call with every enemy observed so far (design §11 q1, ADR-0046)', () => {
    const state = withEnemies(['shadow_fiend', 'crystal_maiden', 'tidehunter']);
    const report = parsed(EnemyResult, enemy(ctxOf(state)));

    // Alphabetical, so two calls in one turn cannot appear to reorder the world.
    expect(report.enemies.map((e) => e.hero)).toEqual([
      'crystal_maiden',
      'shadow_fiend',
      'tidehunter',
    ]);
  });

  it('answers a named hero with a list of one', () => {
    const state = withEnemies(['shadow_fiend', 'crystal_maiden']);
    const report = parsed(EnemyResult, enemy(ctxOf(state), { hero: 'crystal_maiden' }));
    expect(report.enemies.map((e) => e.hero)).toEqual(['crystal_maiden']);
  });

  it('finds a hero through case, spaces and the npc_dota_hero_ prefix', () => {
    const state = withEnemies(['shadow_fiend']);
    for (const asked of [
      'Shadow Fiend',
      'SHADOW_FIEND',
      'npc_dota_hero_shadow_fiend',
      'shadow-fiend',
    ]) {
      const report = parsed(EnemyResult, enemy(ctxOf(state), { hero: asked }));
      expect(report.enemies[0]?.hero).toBe('shadow_fiend');
    }
  });

  it('does not claim a hero is absent from the match, and names what it has instead', () => {
    // The confident falsehood this prevents: "there is no Puck in this game" — said in the same
    // tone as a fact, when the truth is that nothing has read the draft.
    const state = withEnemies(['shadow_fiend', 'crystal_maiden']);
    const result = EnemyResult.parse(enemy(ctxOf(state), { hero: 'puck' })) as { unknown: string };

    expect(result.unknown).toContain('nothing has been observed about "puck"');
    expect(result.unknown).toContain('crystal_maiden, shadow_fiend');
    expect(result.unknown).not.toContain('not in this match');
  });

  it('says nothing has been seen when no enemy has been observed at all', () => {
    expect(EnemyResult.parse(enemy(ctxOf(stateWith([]))))).toEqual({
      unknown: 'no enemy hero has been observed this match yet',
    });
  });

  it('returns unknown for a net worth nobody has read, not zero', () => {
    // The invented number this prevents: `net_worth: 0`, i.e. an enemy carry with nothing.
    const state = withEnemies(['shadow_fiend']);
    const report = parsed(EnemyResult, enemy(ctxOf(state)));
    const one = report.enemies[0]!;

    expect(one.net_worth).toEqual({ unknown: 'never observed this match' });
    expect(one.level).toEqual({ unknown: 'never observed this match' });
    expect(one.alive).toEqual({ unknown: 'never observed this match' });
  });

  it('reports no items seen as unknown, never as an empty list', () => {
    // The claim this prevents: `items_seen: []`, which licenses "they have nothing" at minute 30.
    const state = withEnemies(['shadow_fiend']);
    const report = parsed(EnemyResult, enemy(ctxOf(state)));

    expect(report.enemies[0]?.items_seen).toEqual({
      unknown: 'no item has been seen on this hero',
    });
  });

  it('keeps one confidence and one age per item seen', () => {
    let state = withEnemies(['shadow_fiend']);
    state = writeFact(
      state,
      itemSeenField(HERO, 'blink' as ItemId),
      cvFact(
        'blink' as ItemId,
        { observedAt: asMonoMs(NOW - 20_000), atGameClock: asGameClock(CLOCK) },
        asConfidence(0.91),
        asDetectorId('items'),
      ),
    );
    state = writeFact(
      state,
      itemSeenField(HERO, 'black_king_bar' as ItemId),
      cvFact(
        'black_king_bar' as ItemId,
        { observedAt: asMonoMs(NOW - 240_000), atGameClock: asGameClock(CLOCK) },
        asConfidence(0.55),
        asDetectorId('items'),
      ),
    );

    const report = parsed(EnemyResult, enemy(ctxOf(state)));
    const items = report.enemies[0]!.items_seen;
    if (!Array.isArray(items)) throw new Error('expected a list of items, not an unknown');

    const bkb = items[0]!;
    const blink = items[1]!;
    if (isUnknown(bkb) || isUnknown(blink)) throw new Error('expected two items');

    // A BKB at 0.55 four minutes ago is a different claim from a Blink at 0.91 twenty seconds ago,
    // and the whole point of one fact per item is that the two do not average.
    expect(bkb.value).toBe('black_king_bar');
    expect(bkb.confidence).toBe(0.55);
    expect(bkb.age_seconds).toBeCloseTo(240, 5);
    expect(blink.value).toBe('blink');
    expect(blink.confidence).toBe(0.91);
    expect(blink.age_seconds).toBeCloseTo(20, 5);
  });

  it('leaves the map area unnamed rather than inventing one', () => {
    const state = withEnemies(['shadow_fiend']);
    const report = parsed(EnemyResult, enemy(ctxOf(state)));
    expect(value(report.enemies[0]!.last_seen).area).toBeNull();
  });
});

// -----------------------------------------------------------------------------------------------
// objectives
// -----------------------------------------------------------------------------------------------

describe('objectives', () => {
  const buildings = {
    towers: {
      'radiant:dota_goodguys_tower1_top': 1800,
      'radiant:dota_goodguys_tower2_mid': 2000,
      'dire:dota_badguys_tower1_mid': 0,
      'dire:dota_badguys_tower4_top': 2100,
    },
    barracks: {
      'radiant:dota_goodguys_melee_rax_top': 2200,
      'dire:dota_badguys_range_rax_mid': 0,
    },
    ancient: { radiant: 4500, dire: 4500 },
  };

  it('renders the clock the way a person says it', () => {
    const state = writeFact(
      stateWith([]),
      fieldPath('meta', 'clock'),
      gsiFact(asGameClock(754), { observedAt: NOW, atGameClock: asGameClock(754) }),
    );
    const report = parsed(ObjectivesResult, objectives(ctxOf(state, 754)));
    expect(value(report.clock)).toBe('12:34');
  });

  it('counts buildings from the player’s seat, not the map’s', () => {
    const state = stateWith([
      ['map.buildings', buildings],
      ['meta.team', 'radiant'],
    ]);
    const report = parsed(ObjectivesResult, objectives(ctxOf(state)));
    const value_ = value(report.buildings) as {
      towers: { mine: number; theirs: number };
      barracks: { mine: number; theirs: number };
    };

    expect(value_.towers).toEqual({ mine: 2, theirs: 1 });
    expect(value_.barracks).toEqual({ mine: 1, theirs: 0 });
  });

  it('returns unknown for buildings when it does not know which side the player is on', () => {
    // The invented number this prevents: a tower count rendered the wrong way round. "You're up
    // four towers" is a complete, confident sentence either way, and the player cannot tell.
    const state = stateWith([['map.buildings', buildings]]);
    const report = parsed(ObjectivesResult, objectives(ctxOf(state)));

    expect(report.buildings).toEqual({
      unknown: 'the buildings, or which side you are on, were never observed',
    });
  });

  it('recovers recently lost buildings from the delta ring', () => {
    const before = stateWith([
      ['map.buildings', buildings],
      ['meta.team', 'radiant'],
    ]);
    const fallen = {
      ...buildings,
      towers: { ...buildings.towers, 'radiant:dota_goodguys_tower2_mid': 0 },
    };
    const after = writeFact(
      before,
      fieldPath('map', 'buildings'),
      gsiFact(fallen, { observedAt: NOW, atGameClock: asGameClock(CLOCK) }),
    );
    after.history.push(createDeltaComputer().compute(before, after), asGameClock(CLOCK), NOW);

    const report = parsed(ObjectivesResult, objectives(ctxOf(after)));
    const value_ = value(report.buildings) as {
      recently_lost: { side: string; name: string }[];
      towers: { mine: number };
    };

    expect(value_.recently_lost).toEqual([{ side: 'mine', name: 'mid tier 2' }]);
    expect(value_.towers.mine).toBe(1);
  });

  it('reports nothing recently lost as an empty list, which the history window makes true', () => {
    const state = stateWith([
      ['map.buildings', buildings],
      ['meta.team', 'radiant'],
    ]);
    const report = parsed(ObjectivesResult, objectives(ctxOf(state)));
    expect((value(report.buildings) as { recently_lost: unknown[] }).recently_lost).toEqual([]);
  });

  it('says nobody has seen Roshan rather than reporting a state he is in', () => {
    // `RoshanState` has three values and the third is an absence of observation, not a state.
    for (const state of [stateWith([]), stateWith([['map.roshanState', 'unknown']])]) {
      const report = parsed(ObjectivesResult, objectives(ctxOf(state)));
      expect(report.roshan).toEqual({ unknown: 'nobody has seen Roshan this match' });
    }
  });

  it('gives the respawn window as a window, from the clock the death was seen at', () => {
    const death = { observedAt: asMonoMs(NOW - 60_000), atGameClock: asGameClock(300) };
    const state = writeFact(stateWith([]), fieldPath('map', 'roshanState'), gsiFact('dead', death));

    const report = parsed(ObjectivesResult, objectives(ctxOf(state, 600)));
    const rosh = value(report.roshan) as {
      state: string;
      respawn_window: { opens_in_seconds: number; closes_in_seconds: number; maybe_up: boolean };
    };

    // Died at 5:00, so the window is 13:00–16:00 and it is now 10:00.
    expect(rosh.state).toBe('dead');
    expect(rosh.respawn_window.opens_in_seconds).toBe(180);
    expect(rosh.respawn_window.closes_in_seconds).toBe(360);
    expect(rosh.respawn_window.maybe_up).toBe(false);
  });

  it('leaves the window null when the death was seen at a time nobody recorded', () => {
    // The invented number this prevents: a window counted from a guessed death, which is exactly
    // the "Rosh is probably up" a coach must not say.
    const state = writeFact(
      stateWith([]),
      fieldPath('map', 'roshanState'),
      gsiFact('dead', { observedAt: asMonoMs(NOW - 60_000), atGameClock: null }),
    );
    const report = parsed(ObjectivesResult, objectives(ctxOf(state, 600)));
    expect((value(report.roshan) as { respawn_window: unknown }).respawn_window).toBeNull();
  });

  it('answers rune timings from the clock alone', () => {
    const state = writeFact(
      stateWith([]),
      fieldPath('meta', 'clock'),
      gsiFact(asGameClock(530), { observedAt: NOW, atGameClock: asGameClock(530) }),
    );
    const report = parsed(ObjectivesResult, objectives(ctxOf(state, 530)));
    const runes = value(report.runes);

    // It is 8:50: bounties every 3 minutes, power every 2 from 6:00, water at 2:00 and 4:00 only.
    expect(runes.next_bounty_in_seconds).toBe(10); // 9:00
    expect(runes.next_power_in_seconds).toBe(70); // 10:00
    expect(runes.next_water_in_seconds).toBeNull(); // both gone, and null is not "in 0 seconds"
  });

  it('returns unknown for runes and the clock before the match has one', () => {
    const report = parsed(
      ObjectivesResult,
      objectives(ctxOf(stateWith([], { phase: 'draft' }), null)),
    );
    expect(report.clock).toEqual({ unknown: 'the match has no clock yet' });
    expect(report.runes).toEqual({ unknown: 'the match has no clock yet' });
  });
});

// -----------------------------------------------------------------------------------------------
// economy
// -----------------------------------------------------------------------------------------------

describe('economy', () => {
  function withNetWorths(allies: number, enemies: number): WorldState {
    let state = stateWith([['self.netWorth', 12_000]]);
    const at = { observedAt: NOW, atGameClock: asGameClock(CLOCK) };
    for (let i = 0; i < allies; i += 1) {
      state = writeFact(
        state,
        heroField('allies', `ally${String(i)}` as HeroId, 'netWorth'),
        gsiFact(8000, at),
      );
    }
    for (let i = 0; i < enemies; i += 1) {
      state = writeFact(
        state,
        heroField('enemies', `foe${String(i)}` as HeroId, 'netWorth'),
        gsiFact(9000, at),
      );
    }
    return state;
  }

  it('reports the player’s own numbers, which are the ones GSI knows', () => {
    const state = stateWith([
      ['self.netWorth', 12_340],
      ['self.gpm', 612],
      ['self.xpm', 704],
      ['self.lastHits', 187],
      ['self.denies', 12],
    ]);
    const report = parsed(EconomyResult, economy(ctxOf(state)));

    expect(value(report.my_net_worth)).toBe(12_340);
    expect(value(report.gpm)).toBe(612);
    expect(value(report.last_hits)).toBe(187);
    expect(value(report.denies)).toBe(12);
  });

  it('gives the lead when all ten net worths are known', () => {
    const report = parsed(EconomyResult, economy(ctxOf(withNetWorths(4, 5))));
    expect(value(report.team_net_worth)).toEqual({
      ours: 12_000 + 4 * 8000,
      theirs: 5 * 9000,
      lead: 12_000 + 4 * 8000 - 5 * 9000,
    });
  });

  it('returns unknown for the lead when one net worth is missing, not a smaller lead', () => {
    // The invented number this prevents: a lead computed from nine of ten, which is not a smaller
    // lead — it is a wrong one, wrong in whichever direction the missing hero happened to fall.
    const report = parsed(EconomyResult, economy(ctxOf(withNetWorths(4, 4))));

    expect(report.team_net_worth).toEqual({
      unknown:
        'not every hero on both sides has a net worth yet — the scoreboard has not been seen',
    });
  });

  it('reports lane equity as unknown, because nothing in this build reads a scoreboard', () => {
    const report = parsed(EconomyResult, economy(ctxOf(withNetWorths(4, 5))));
    expect(report.lanes).toEqual({
      unknown: 'lane net worth needs the scoreboard, and the source that would know is not running',
    });
  });

  it('returns unknown for gpm nobody observed, not zero', () => {
    // The invented number this prevents: `gpm: 0`, which reads as a player who is doing nothing.
    const report = parsed(EconomyResult, economy(ctxOf(stateWith([]))));
    expect(report.gpm).toEqual({ unknown: 'never observed this match' });
    expect(report.my_net_worth).toEqual({ unknown: 'never observed this match' });
  });
});

// -----------------------------------------------------------------------------------------------
// The two formatters
// -----------------------------------------------------------------------------------------------

describe('clockString', () => {
  it('matches the grammar the model is shown', () => {
    expect(clockString(0)).toBe('0:00');
    expect(clockString(754)).toBe('12:34');
    expect(clockString(-90)).toBe('-1:30'); // pre-horn is not 0:00, which is why the sign is grammar
    expect(clockString(3900)).toBe('1:05:00');
    expect(clockString(3599)).toBe('59:59');
    expect(clockString(3600)).toBe('1:00:00');
  });

  it('produces only strings the protocol accepts', () => {
    const pattern = /^-?\d{1,3}:[0-5]\d(:[0-5]\d)?$/;
    for (let t = -180; t < 7300; t += 7) expect(clockString(t)).toMatch(pattern);
  });
});

describe('buildingName', () => {
  it('names buildings the way they are said out loud', () => {
    expect(buildingName('radiant:dota_goodguys_tower2_mid')).toBe('mid tier 2');
    expect(buildingName('dire:dota_badguys_tower1_bot')).toBe('bottom tier 1');
    expect(buildingName('radiant:dota_goodguys_melee_rax_top')).toBe('top melee barracks');
    expect(buildingName('dire:dota_badguys_range_rax_mid')).toBe('mid ranged barracks');
    // Both tier 4s stand at the ancient, so a lane would describe a place that is not there.
    expect(buildingName('radiant:dota_goodguys_tower4_top')).toBe('tier 4');
  });

  it('reads an unrecognised building aloud rather than dropping it', () => {
    expect(buildingName('radiant:dota_goodguys_fillerpit_bot')).toBe('fillerpit bot');
  });
});

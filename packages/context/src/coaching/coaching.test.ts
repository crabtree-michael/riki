/**
 * The coaching brief. Tier 1 — no game, no session, no network.
 *
 * coaching-architecture.md §13's rows for this component, in order, plus the two properties that
 * only became assertable once the code existed:
 *
 * - `BRIEF_PLAN` totality, over values as well as over types.
 * - Age and confidence on every CV-derived field; below-threshold dropped rather than hedged.
 * - `omitted` complete, and truncation in the plan's declared order.
 * - An empty brief, which is a turn that does not happen (§6.5).
 * - **The egress test**: the one that cannot be walked back once it has failed in the field.
 */

import { describe, expect, it } from 'vitest';
import type { FieldPath, WorldSnapshot } from '../common/ports.js';
import type { AdviceRecord, AdviceTopic } from '../memory/types.js';
import type { CoachingMemoryReader } from '../memory/contracts.js';
import type { GameClock, HeroId, ItemId, MonoMs, TurnId } from '../common/types.js';
import type { BriefRequest, BriefSectionId } from './types.js';
import { FakeWorldModel, observed } from '../testing/index.js';
import { classifyField, DEFAULT_PRIVACY } from '../render/privacy.js';
import { BRIEF_PLAN, createBriefPlanner, planKeyFor } from './plan.js';
import { createBriefRenderer } from './render.js';
import { ALL_BRIEF_SECTIONS } from './sections/index.js';

const NOW = 60_000 as MonoMs;
const BKB: AdviceTopic = { of: 'item', item: 'black_king_bar' as ItemId };

function request(over: Partial<BriefRequest> = {}): BriefRequest {
  return {
    turnId: 't0' as TurnId,
    cause: { by: 'player', gesture: 'push_to_talk' },
    now: NOW,
    budget: { maxTokens: 200, spentTokens: 0 },
    privacy: DEFAULT_PRIVACY,
    ...over,
  };
}

/** A mid-game world with something for every section, so a plan row can be read off the output. */
function midGame(): FakeWorldModel {
  return new FakeWorldModel({
    clock: 872 as GameClock,
    roster: {
      self: 'riki' as HeroId,
      enemies: ['nevermore', 'tidehunter', 'crystal_maiden', 'windranger', 'zuus'] as HeroId[],
    },
    facts: {
      'self.hpPct': observed(84),
      'self.mpPct': observed(61),
      'self.gold': observed(1840),
      'self.goldReliable': observed(320),
      'self.netWorth': observed(7200),
      'self.lastHits': observed(96),
      'self.gpm': observed(512),
      'self.abilities': observed([
        { id: 'blink_strike', cooldown: 0 },
        { id: 'invis', cooldown: 4 },
      ]),
      'enemies.nevermore.ultimate': observed(
        { id: 'requiem', cooldown: 0 },
        { source: 'cv', confidence: 0.82, ageMs: 9_000 },
      ),
      'enemies.tidehunter.ultimate': observed({ id: 'ravage', cooldown: 41 }, { source: 'log' }),
      // Fresh, aged and below-threshold — the three cases `AgeFormatter` renders differently.
      'enemies.nevermore.area': observed('bot', { source: 'cv', confidence: 0.91, ageMs: 4_000 }),
      'enemies.tidehunter.area': observed('top', { source: 'cv', confidence: 0.86, ageMs: 8_000 }),
      'enemies.crystal_maiden.area': observed('mid', {
        source: 'cv',
        confidence: 0.31,
        ageMs: 31_000,
      }),
      'derived.threats': observed(
        [
          { hero: 'nevermore', area: 'bot', etaSeconds: 3 },
          { hero: 'zuus', area: 'mid', etaSeconds: 7 },
        ],
        { source: 'derived', confidence: 0.78 },
      ),
      'derived.nextItem': observed({ item: 'diffusal2', inSeconds: 40 }),
      'derived.buybackCost': observed(1650),
      'derived.nextRuneAt': observed(900),
      'derived.roshanWindowAt': observed(1010),
      'derived.nextStackAt': observed(893),
      'derived.paceNetWorth': observed(1200),
      'derived.paceLevel': observed(-1),
      'map.daytime': observed(false),
    },
    unseen: ['windranger', 'zuus'] as HeroId[],
  });
}

function memory(record: AdviceRecord | undefined): CoachingMemoryReader {
  return {
    recent: () => record,
    lastSpokeAt: () => 800 as GameClock,
    silentFor: () => 72,
  };
}

const renderer = createBriefRenderer();

// -----------------------------------------------------------------------------------------------
// BRIEF_PLAN
// -----------------------------------------------------------------------------------------------

describe('BRIEF_PLAN', () => {
  it('has a row for every plan key, and every row names real sections', () => {
    // §13's totality row. A missing row is a coaching turn with an empty brief, which §6.5 turns
    // into silence — a detector that fires and says nothing, which reads as a bug in the detector.
    const known = new Set(ALL_BRIEF_SECTIONS.map((s) => s.id));
    for (const [key, sections] of Object.entries(BRIEF_PLAN)) {
      expect(sections.length, `${key} has no sections`).toBeGreaterThan(0);
      for (const id of sections) expect(known, `${key} names ${id}`).toContain(id);
    }
  });

  it('names every implemented section in at least one row', () => {
    // The other direction, and the quieter failure: a section this package builds but no plan row
    // asks for is a section that never renders, and nothing else would notice.
    const used = new Set(Object.values(BRIEF_PLAN).flat());
    for (const source of ALL_BRIEF_SECTIONS) expect(used).toContain(source.id);
  });

  it('gives a player question the widest brief there is', () => {
    // §3.2's first mitigation: no cause to focus on means everything the budget allows, which is
    // what recovers most of what `get_enemy_detail` and `get_minimap_summary` used to answer.
    const widest = Math.max(...Object.values(BRIEF_PLAN).map((row) => row.length));
    expect(BRIEF_PLAN.player_question).toHaveLength(widest);
  });

  it('leads every trigger row with the section the trigger is about', () => {
    expect(BRIEF_PLAN.enemy_missing[0]).toBe('positions');
    expect(BRIEF_PLAN.low_hp_no_escape[0]).toBe('threat');
    expect(BRIEF_PLAN.can_afford_key_item[0]).toBe('economy');
    expect(BRIEF_PLAN.rune_soon[0]).toBe('windows');
    expect(BRIEF_PLAN.ult_ready[0]).toBe('cooldowns');
  });

  it('routes an unknown event id to the widest row rather than to nothing', () => {
    // A detector shipped ahead of its row. The turn is going to happen — the gates admitted it —
    // so the choice is a broad brief or no brief, and no brief is a turn with nothing behind it.
    expect(
      planKeyFor(request({ cause: { by: 'trigger', event: 'brand_new' as never, salience: 1 } })),
    ).toBe('player_question');
  });

  it('is a lookup and not a scoring function', () => {
    const planner = createBriefPlanner();
    const req = request({ cause: { by: 'trigger', event: 'rune_soon' as never, salience: 0.7 } });
    expect(planner.plan(req)).toEqual(BRIEF_PLAN.rune_soon);
    // Salience does not move a section. If it ever does, the ordering has stopped being a
    // golden-testable fact and become a number nobody can predict from a fixture (§4.4).
    const louder = request({ cause: { by: 'trigger', event: 'rune_soon' as never, salience: 1 } });
    expect(planner.plan(louder)).toEqual(planner.plan(req));
  });
});

// -----------------------------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------------------------

describe('BriefRenderer', () => {
  it('renders the sections its cause asked for, in the plan order, and nothing else', () => {
    const brief = renderer.render(midGame().snapshot(NOW), {
      ...request({ cause: { by: 'trigger', event: 'enemy_missing' as never, salience: 0.8 } }),
    });

    expect(brief.text.startsWith('positions:')).toBe(true);
    expect(brief.text).toContain('threat:');
    expect(brief.text).not.toContain('economy:');
    expect(brief.text).not.toContain('windows:');
  });

  it('carries an age and a confidence on every CV fact, and drops what is below the floor', () => {
    const brief = renderer.render(midGame().snapshot(NOW), {
      ...request({ cause: { by: 'trigger', event: 'enemy_missing' as never, salience: 0.8 } }),
    });

    // Two positions survive with their ages; the 0.31-confidence one is dropped, not hedged —
    // hedging spends tokens to say nothing (render/age.ts).
    expect(brief.text).toContain('nevermore bot ~4s ago(0.91)');
    expect(brief.text).toContain('tidehunter top ~8s ago(0.86)');
    expect(brief.text).not.toContain('crystal_maiden');
  });

  it('never renders a bare value for a fact that has an age', () => {
    // The structural form of dota2 §4 rule 3: there is no path from an `Observed<T>` to the text
    // that does not go past `AgeFormatter`. A CV value appearing without its marker means someone
    // added a helper that takes a bare `T`.
    const brief = renderer.render(midGame().snapshot(NOW), request());
    for (const [value, marker] of [
      ['bot', '(0.91)'],
      ['top', '(0.86)'],
    ] as const) {
      if (brief.text.includes(value)) expect(brief.text).toContain(marker);
    }
  });

  it('truncates from the bottom of the plan up, and records what went', () => {
    const world = midGame().snapshot(NOW);
    const req = request({ cause: { by: 'player', gesture: 'push_to_talk' } });

    const full = renderer.render(world, req);
    const tight = renderer.render(world, { ...req, budget: { maxTokens: 40, spentTokens: 0 } });

    expect(tight.tokens).toBeLessThan(full.tokens);
    expect(tight.omitted.length).toBeGreaterThan(0);
    // The lead section of the row survives: a brief either carries what the turn is about or
    // renders nothing (§6.5). There is no middle state.
    expect(tight.text.startsWith('threat:')).toBe(true);
    expect(tight.omitted).not.toContain('threat');
  });

  it('records a section the world model could not fill, distinctly from one the budget ate', () => {
    const empty = new FakeWorldModel({ facts: {}, roster: { enemies: [] } });
    const brief = renderer.render(empty.snapshot(NOW), request());
    // Absent and empty say different things, and the golden corpus should show which happened.
    expect(brief.omitted).toContain('economy');
    expect(brief.omitted).toContain('windows');
  });

  it('is pure: the same world and request render the same text', () => {
    const world = midGame().snapshot(NOW);
    const req = request();
    expect(renderer.render(world, req)).toStrictEqual(renderer.render(world, req));
  });
});

// -----------------------------------------------------------------------------------------------
// The empty brief (§6.5)
// -----------------------------------------------------------------------------------------------

describe('an empty brief', () => {
  it('is a value, not an exception, and says so', () => {
    const nothing = new FakeWorldModel({ facts: {}, roster: { enemies: [] } });
    const brief = renderer.render(nothing.snapshot(NOW), request());

    expect(brief.empty).toBe(true);
    expect(brief.text).toBe('');
    expect(brief.sections).toEqual([]);
    // Every section the plan asked for is accounted for. "Riki had nothing to say" is a complete
    // record, not an absence of one.
    expect(brief.omitted).toEqual(BRIEF_PLAN.player_question);
  });

  it('is not thrown, for any cause, against a world model that holds nothing', () => {
    // Total functions, inherited by name from the design being replaced (§4.3). Nothing on this
    // path throws or rejects, so there is no failure mode that stalls a turn.
    const nothing = new FakeWorldModel({ facts: {}, roster: { enemies: [] } }).snapshot(NOW);
    for (const key of Object.keys(BRIEF_PLAN)) {
      const cause =
        key === 'player_question'
          ? ({ by: 'player', gesture: 'push_to_talk' } as const)
          : key === 'system'
            ? ({ by: 'system', reason: 'match_started' } as const)
            : ({ by: 'trigger', event: key as never, salience: 0.5 } as const);
      expect(() => renderer.render(nothing, request({ cause }))).not.toThrow();
    }
  });
});

// -----------------------------------------------------------------------------------------------
// history (§5.4)
// -----------------------------------------------------------------------------------------------

describe('the history section', () => {
  const record: AdviceRecord = {
    topic: BKB,
    firstAt: 700 as GameClock,
    lastAt: 760 as GameClock,
    count: 2,
    response: 'ignored',
  };

  /** A repeat of the advice the topic is about — the case history exists for. */
  const repeat = request({
    cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 0.6 },
    topic: BKB,
  });

  it('renders nothing on a first mention', () => {
    const withMemory = createBriefRenderer({ coaching: memory(undefined) });
    expect(withMemory.render(midGame().snapshot(NOW), repeat).text).not.toContain('history:');
  });

  it('says how the first attempt went, so the model does not repeat itself verbatim', () => {
    const withMemory = createBriefRenderer({ coaching: memory(record) });
    const brief = withMemory.render(midGame().snapshot(NOW), repeat);

    expect(brief.text).toContain('raised 2× on this');
    expect(brief.text).toContain('last at 12:40');
    expect(brief.text).toContain('they did not act on it');
  });

  it('renders nothing without a topic, rather than guessing which advice this is', () => {
    // §6.6 row 4's whole point: one value, one origin. A brief that inferred a topic from the
    // event id would be a second table that can disagree with the novelty gate's.
    const withMemory = createBriefRenderer({ coaching: memory(record) });
    const untopiced: BriefRequest = {
      turnId: repeat.turnId,
      cause: repeat.cause,
      now: repeat.now,
      budget: repeat.budget,
      privacy: repeat.privacy,
    };
    expect(withMemory.render(midGame().snapshot(NOW), untopiced).text).not.toContain('history:');
  });

  it('renders nothing when no memory was wired, rather than claiming a first mention', () => {
    expect(renderer.render(midGame().snapshot(NOW), repeat).text).not.toContain('history:');
  });

  it('is the first thing the budget eats, and that is the right order', () => {
    // It is the *least* urgent line in the brief — useful context about a repeat, never the thing
    // the turn is about. A tight budget should spend its tokens on the moment, not on the memo.
    const withMemory = createBriefRenderer({ coaching: memory(record) });
    const tight = withMemory.render(midGame().snapshot(NOW), {
      ...repeat,
      budget: { maxTokens: 30, spentTokens: 0 },
    });
    expect(tight.omitted).toContain('history');
    expect(tight.text.startsWith('economy:')).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// Egress — the test that cannot be walked back once it has failed in the field
// -----------------------------------------------------------------------------------------------

describe('privacy', () => {
  /** Wraps a snapshot so a test can see every path a section touched. */
  function recording(world: WorldSnapshot): { snapshot: WorldSnapshot; paths: string[] } {
    const paths: string[] = [];
    return {
      paths,
      snapshot: {
        ...world,
        get: <T>(path: FieldPath) => {
          paths.push(String(path));
          return world.get<T>(path);
        },
        roster: () => world.roster(),
        unseenFor: (seconds: number) => world.unseenFor(seconds),
      },
    };
  }

  it('reads no field that classifies as chat text or a player name', () => {
    // Stronger than asserting on the output, and deliberately so: an output assertion passes for a
    // section that reads chat and happens to drop it this time. This one fails the moment a
    // section *reaches* for one, which is where the bug actually is (dota2 §7's ⚠ row).
    const { snapshot, paths } = recording(midGame().snapshot(NOW));
    for (const key of Object.keys(BRIEF_PLAN)) {
      const cause =
        key === 'player_question'
          ? ({ by: 'player', gesture: 'push_to_talk' } as const)
          : key === 'system'
            ? ({ by: 'system', reason: 'match_started' } as const)
            : ({ by: 'trigger', event: key as never, salience: 0.5 } as const);
      renderer.render(snapshot, request({ cause, budget: { maxTokens: 2_000, spentTokens: 0 } }));
    }

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(classifyField(path as FieldPath), path).not.toBe('chat_text');
      expect(classifyField(path as FieldPath), path).not.toBe('player_name');
    }
  });

  it('never emits chat text that is sitting in the world model', () => {
    const world = midGame();
    world.set('chat.recent', observed('gg ez ' + 'SECRET'));
    world.set('enemies.nevermore.name', observed('SECRET'));

    const brief = renderer.render(world.snapshot(NOW), request());
    expect(brief.text).not.toContain('SECRET');
  });
});

// -----------------------------------------------------------------------------------------------
// The budget (§5.5)
// -----------------------------------------------------------------------------------------------

describe('the brief budget', () => {
  it('respects a budget the caller has already spent against', () => {
    const world = midGame().snapshot(NOW);
    const shared = renderer.render(world, {
      ...request(),
      budget: { maxTokens: 200, spentTokens: 170 },
    });
    expect(shared.tokens).toBeLessThanOrEqual(30 + 8);
  });

  it('reports every section it dropped, and the set is exactly plan minus rendered', () => {
    const world = midGame().snapshot(NOW);
    const brief = renderer.render(world, {
      ...request(),
      budget: { maxTokens: 45, spentTokens: 0 },
    });

    const rendered = new Set(brief.sections.map((s) => String(s.id) as BriefSectionId));
    const planned = BRIEF_PLAN.player_question;
    expect([...rendered, ...brief.omitted].sort()).toEqual([...planned].sort());
  });
});

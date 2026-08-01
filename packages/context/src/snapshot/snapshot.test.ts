/**
 * Tier 2 — the snapshot renderer. Tier 1 by REPO_SKELETON.md §5.3.
 *
 * The tests §13 names for this unit, in the order it names them: the truncation ladder, the
 * `seen`/`unseen` pairing, cause-driven promotion, and the two dota2 §4 rules that this tier shares
 * with Tier 3 — a stale CV fact renders with its age and confidence, and a below-threshold fact is
 * dropped rather than hedged.
 */

import { describe, expect, it } from 'vitest';
import type { GameClock, HeroId, MonoMs, TurnId } from '../common/types.js';
import type { SnapshotContext, TapeEvent, TurnCause } from './types.js';
import { FakeWorldModel, observed } from '../testing/index.js';
import { DEFAULT_PRIVACY } from '../render/privacy.js';
import { createSnapshotRenderer } from './renderer.js';
import { createPriorityLadder, promoted, SNAPSHOT_LADDER } from './ladder.js';

const NOW = 1_000 as MonoMs;

function world(overrides: Record<string, ReturnType<typeof observed>> = {}): FakeWorldModel {
  return new FakeWorldModel({
    clock: 872 as GameClock,
    roster: { self: 'riki' as HeroId, enemies: ['sf', 'tide', 'zuus'] as HeroId[] },
    facts: {
      'self.hero': observed('riki'),
      'self.level': observed(11),
      'self.hpPct': observed(84),
      'self.mpPct': observed(61),
      'self.alive': observed(true),
      'self.area': observed('top jungle'),
      'map.daytime': observed(true),
      'self.gold': observed(1840),
      'self.goldReliable': observed(320),
      'self.netWorth': observed(7200),
      'self.kda': observed({ kills: 4, deaths: 1, assists: 3 }),
      'self.lastHits': observed(96),
      'self.denies': observed(12),
      'self.gpm': observed(512),
      'self.abilities': observed([
        { id: 'blink_strike', cooldown: 0 },
        { id: 'tricks_of_trade', cooldown: 4 },
      ]),
      'self.items': observed([{ id: 'diffusal', charges: 1 }, { id: 'phase' }]),
      'self.freeSlots': observed(3),
      'enemies.sf.level': observed(12),
      'enemies.sf.alive': observed(true),
      'enemies.tide.level': observed(11),
      'enemies.tide.alive': observed(false),
      'enemies.tide.respawnIn': observed(22),
      'enemies.zuus.level': observed(11),
      'enemies.zuus.alive': observed(true),
      'enemies.sf.area': observed('bot', { source: 'cv', confidence: 0.91, ageMs: 4000 }),
      'derived.nextItem': observed({ item: 'diffusal2', inSeconds: 40 }),
      'derived.netWorthLead': observed(3100),
      'map.towers': observed([{ id: 't1 mid', side: 'them', down: true }]),
      ...overrides,
    },
    unseen: ['zuus'] as HeroId[],
  });
}

function ctx(overrides: Partial<SnapshotContext> = {}): SnapshotContext {
  return {
    turnId: 't1' as TurnId,
    now: NOW,
    cause: { by: 'player', gesture: 'push_to_talk' },
    budget: { maxTokens: 400, spentTokens: 0 },
    privacy: DEFAULT_PRIVACY,
    tape: [],
    elisionBase: null,
    ...overrides,
  };
}

const renderer = createSnapshotRenderer();

describe('the format', () => {
  it('renders the dota2 §6.2 line groups', () => {
    const rendered = renderer.render(world().snapshot(NOW), ctx());
    expect(rendered.text).toContain('T 14:32 | day | you: riki, lvl 11, 84% hp');
    expect(rendered.text).toContain('gold 1840 (rel 320) | nw 7.2k | 4/1/3 | lh 96/12 | gpm 512');
    expect(rendered.text).toContain('abils: blink_strike UP, tricks_of_trade 4s');
    expect(rendered.text).toContain('enemies: sf lvl 12 alive · tide lvl 11 DEAD 22s');
  });

  it('never produces an empty string, even with nothing in the world model', () => {
    // §10's "world model has no snapshot yet (pre-horn)" row: a draft-phase snapshot, never an
    // empty one. The header is undroppable precisely so this cannot regress.
    const empty = new FakeWorldModel({ clock: null, roster: { enemies: [] }, facts: {} });
    const rendered = renderer.render(empty.snapshot(NOW), ctx());
    expect(rendered.text).toBe('T pre-horn');
  });
});

describe('uncertainty', () => {
  it('renders a stale CV position with its age and confidence, never as a bare fact', () => {
    // dota2 §4 rule 3, and REPO_SKELETON §5.4's named risk. The 30-second case is the one the
    // skeleton asks for by name.
    const rendered = renderer.render(
      world({
        'enemies.sf.area': observed('bot', { source: 'cv', confidence: 0.8, ageMs: 30_000 }),
      }).snapshot(NOW),
      ctx(),
    );
    expect(rendered.text).toContain('sf bot unseen >20s(0.80)');
    expect(rendered.text).not.toContain('sf bot\n');
  });

  it('drops a below-threshold fact rather than hedging it', () => {
    const rendered = renderer.render(
      world({
        'enemies.sf.area': observed('bot', { source: 'cv', confidence: 0.2, ageMs: 4000 }),
      }).snapshot(NOW),
      ctx(),
    );
    expect(rendered.text).not.toContain('sf bot');
    // The line itself vanishes rather than becoming `seen:` with nothing after it.
    expect(rendered.text).not.toMatch(/^seen:\s*$/mu);
  });
});

describe('the truncation ladder', () => {
  it('keeps the five undroppable sections under any budget', () => {
    const rendered = renderer.render(
      world().snapshot(NOW),
      ctx({ budget: { maxTokens: 1, spentTokens: 0 } }),
    );
    for (const id of ['header', 'self_economy', 'self_abilities', 'self_items', 'enemies']) {
      expect(rendered.omitted).not.toContain(id);
    }
    expect(rendered.truncated).toBe(true);
  });

  it('drops `recent` before anything else', () => {
    const tape: TapeEvent[] = [
      { id: 'hero_died' as never, at: 850 as GameClock, text: 'tide died top' },
    ];
    // dota2 §6.2 names history as the first thing to go. A budget just under the full render
    // should cost exactly the tape and nothing else.
    const tight = renderer.render(
      world().snapshot(NOW),
      ctx({ tape, budget: { maxTokens: 155, spentTokens: 0 } }),
    );
    expect(tight.omitted).toStrictEqual(['recent']);
  });

  it('drops `seen` and `unseen` together, never one without the other', () => {
    // `unseen >20s: zuus` alone reads as a complete account of where the enemy team is, which is
    // the opposite of what it says (§5.2).
    for (let budget = 20; budget < 140; budget += 1) {
      const rendered = renderer.render(
        world().snapshot(NOW),
        ctx({ budget: { maxTokens: budget, spentTokens: 0 } }),
      );
      const omitted = new Set(rendered.omitted.map(String));
      const text = rendered.text;
      expect(omitted.has('seen') === omitted.has('unseen')).toBe(true);
      expect(text.includes('unseen >20s')).toBe(text.includes('seen:'));
    }
  });
});

describe('cause-driven promotion', () => {
  const ladder = createPriorityLadder();

  it('promotes exactly one section, by lookup rather than by scoring', () => {
    expect(ladder.promote('rune_soon' as never)).toBe('derived');
    expect(ladder.promote('enemy_missing' as never)).toBe('seen');
    // An event this table has not heard of promotes nothing, which is the correct default.
    expect(ladder.promote('something_new' as never)).toBeNull();
  });

  it('moves `derived` above `seen` for a rune trigger', () => {
    const cause: TurnCause = { by: 'trigger', event: 'rune_soon' as never, salience: 0.8 };
    const entries = promoted(SNAPSHOT_LADDER, ladder.promote('rune_soon' as never), ladder);
    const priority = new Map(entries.map((e) => [e.id, e.priority]));
    expect(priority.get('derived')).toBeGreaterThan(priority.get('seen') ?? 0);

    // The same budget, the same world, one different cause. The turn exists because of the rune;
    // the line that explains it should not be what the budget eats.
    const budget = { maxTokens: 130, spentTokens: 0 };
    const promotedRender = renderer.render(world().snapshot(NOW), ctx({ cause, budget }));
    const plain = renderer.render(world().snapshot(NOW), ctx({ budget }));

    expect(promotedRender.omitted).not.toContain('derived');
    expect(promotedRender.omitted).toContain('seen');
    expect(plain.omitted).toContain('derived');
    expect(plain.omitted).not.toContain('seen');
  });

  it('promotes `unseen` along with `seen`, or the promotion causes the drop it prevents', () => {
    // Promoting `seen` alone leaves `unseen` at the bottom of the ladder; it drops first, and the
    // `dropsWith` closure then takes `seen` with it.
    const entries = promoted(SNAPSHOT_LADDER, 'seen', ladder);
    const priority = new Map(entries.map((e) => [e.id, e.priority]));
    expect(priority.get('unseen')).toBeGreaterThan(priority.get('derived') ?? 0);
    expect(priority.get('seen')).toBeGreaterThan(priority.get('unseen') ?? 0);
  });
});

describe('elision', () => {
  it('is off unless a base is supplied', () => {
    const first = renderer.render(world().snapshot(NOW), ctx());
    const second = renderer.render(world().snapshot(NOW), ctx());
    expect(second.text).toBe(first.text);
    expect(second.text).not.toContain('unchanged');
  });

  it('carries the base clock in the marker, so a broken chain is a question the model can ask', () => {
    const base = renderer.render(world().snapshot(NOW), ctx());
    const elided = renderer.render(
      world().snapshot(NOW),
      ctx({ elisionBase: { rendered: base, clock: 872 as GameClock } }),
    );
    expect(elided.text).toContain('(unchanged since 14:32)');
    // Never the header: it carries the clock, which is the one thing a delta must not hide.
    expect(elided.text).toContain('T 14:32');
    expect(elided.tokens).toBeLessThan(base.tokens);
  });
});

describe('privacy', () => {
  it('keeps chat out of the `recent:` line with the default policy', () => {
    // dota2 §7's ⚠ row is other people's words, and this is the second of the two gates.
    const tape: TapeEvent[] = [
      { id: 'chat_message' as never, at: 860 as GameClock, text: 'SomePlayer: gg go next' },
      { id: 'hero_died' as never, at: 850 as GameClock, text: 'tide died top' },
    ];
    const rendered = renderer.render(world().snapshot(NOW), ctx({ tape }));
    expect(rendered.text).not.toContain('gg go next');
    expect(rendered.text).toContain('tide died top');
  });
});

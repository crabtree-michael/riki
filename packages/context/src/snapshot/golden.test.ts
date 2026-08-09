/**
 * Tier 2 — golden. REPO_SKELETON.md §5.3.
 *
 * > The format **is** the interface to the LLM, so a change to it should show up as a readable
 * > diff.
 *
 * That is the whole argument for this file. Everything Tier 1 asserts about the snapshot is a rule
 * — the ladder holds, a stale fact carries its age, the pair drops together. None of those catch
 * the change that matters most in practice, which is somebody making the text read differently.
 * Prompt engineering is a format change by another name (§14), and it should be reviewed the way a
 * format change is: as a diff against a committed expectation, in `fixtures/golden/snapshot/`.
 *
 * Four scenes, chosen to cover the states the renderer behaves differently in rather than four
 * moments of the same match: the draft with no clock, a laning phase where everything is fresh, a
 * mid-game where CV facts have aged into hypotheses, and a tight budget where the ladder actually
 * fires. `omitted` is committed alongside the text, because what survives a tight budget is a
 * design decision and not an accident (§5.1).
 *
 * There used to be a fifth — the same mid-game world under the same budget with a `rune_soon`
 * cause, whose whole purpose was to make the promotion rule a diff. ADR-0042 deleted the causes,
 * so the ladder is fixed and the fixture had nothing left to say.
 */

import { describe, expect, it } from 'vitest';
import type { GameClock, HeroId, MonoMs, TurnId } from '../common/types.js';
import type { SnapshotContext } from './types.js';
import { FakeWorldModel, observed } from '../testing/index.js';
import { DEFAULT_PRIVACY } from '../render/privacy.js';
import { createSnapshotRenderer } from './renderer.js';

const NOW = 60_000 as MonoMs;
const renderer = createSnapshotRenderer();

function render(world: FakeWorldModel, overrides: Partial<SnapshotContext> = {}): string {
  const rendered = renderer.render(world.snapshot(NOW), {
    turnId: 'golden' as TurnId,
    now: NOW,
    cause: { by: 'player', gesture: 'push_to_talk' },
    budget: { maxTokens: 400, spentTokens: 0 },
    privacy: DEFAULT_PRIVACY,
    ...overrides,
  });

  // The committed artifact is the text *and* what was left out. A change that silently drops a
  // line would otherwise show up as a smaller diff than a change that reworded one.
  return [
    rendered.text,
    '',
    `--- ${String(rendered.tokens)} tokens${rendered.truncated ? ', truncated' : ''}`,
    `--- omitted: ${rendered.omitted.length === 0 ? '(none)' : rendered.omitted.map(String).join(', ')}`,
    '',
  ].join('\n');
}

/** Draft: the world model has heroes and nothing else, and the clock is null (§10's pre-horn row). */
function draftPhase(): FakeWorldModel {
  return new FakeWorldModel({
    clock: null,
    roster: {
      self: 'riki' as HeroId,
      allies: ['zuus', 'ogre_magi'] as HeroId[],
      enemies: ['nevermore', 'tidehunter', 'crystal_maiden', 'windranger', 'zuus'] as HeroId[],
    },
    facts: { 'self.hero': observed('riki'), 'self.level': observed(1) },
  });
}

function laning(): FakeWorldModel {
  return new FakeWorldModel({
    clock: 385 as GameClock,
    roster: { self: 'riki' as HeroId, enemies: ['nevermore', 'tidehunter'] as HeroId[] },
    facts: {
      'self.hero': observed('riki'),
      'self.level': observed(6),
      'self.hpPct': observed(72),
      'self.mpPct': observed(40),
      'self.alive': observed(true),
      'self.area': observed('safe lane'),
      'map.daytime': observed(true),
      'self.gold': observed(640),
      'self.goldReliable': observed(0),
      'self.netWorth': observed(2400),
      'self.kda': observed({ kills: 1, deaths: 0, assists: 1 }),
      'self.lastHits': observed(38),
      'self.denies': observed(6),
      'self.gpm': observed(384),
      'self.abilities': observed([
        { id: 'smoke_screen', cooldown: 0 },
        { id: 'blink_strike', cooldown: 6 },
        { id: 'tricks_of_trade', cooldown: 0 },
        { id: 'invis', cooldown: 0 },
      ]),
      'self.items': observed([{ id: 'wraith_band' }, { id: 'tp', charges: 1 }]),
      'self.freeSlots': observed(4),
      'enemies.nevermore.level': observed(6),
      'enemies.nevermore.alive': observed(true),
      'enemies.tidehunter.level': observed(5),
      'enemies.tidehunter.alive': observed(true),
      'enemies.nevermore.area': observed('mid', { source: 'cv', confidence: 0.94, ageMs: 800 }),
      'enemies.tidehunter.area': observed('off lane', {
        source: 'cv',
        confidence: 0.88,
        ageMs: 2600,
      }),
      'derived.nextItem': observed({ item: 'diffusal', inSeconds: 95 }),
      'derived.nextRuneAt': observed(420),
      'derived.netWorthLead': observed(-800),
    },
  });
}

/** Mid-game: the interesting one. Two heroes unseen, one position aged into a hypothesis. */
function midGame(): FakeWorldModel {
  return new FakeWorldModel({
    clock: 872 as GameClock,
    roster: {
      self: 'riki' as HeroId,
      enemies: ['nevermore', 'tidehunter', 'crystal_maiden', 'windranger', 'zuus'] as HeroId[],
    },
    facts: {
      'self.hero': observed('riki'),
      'self.level': observed(11),
      'self.hpPct': observed(84),
      'self.mpPct': observed(61),
      'self.alive': observed(true),
      'self.area': observed('top jungle'),
      'map.daytime': observed(false),
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
        { id: 'smoke_screen', cooldown: 0 },
        { id: 'invis', cooldown: 0 },
      ]),
      'self.items': observed([
        { id: 'diffusal', charges: 1 },
        { id: 'phase' },
        { id: 'wraith_band' },
        { id: 'tp', charges: 1 },
      ]),
      'self.stash': observed([]),
      'self.freeSlots': observed(2),
      'enemies.nevermore.level': observed(12),
      'enemies.nevermore.alive': observed(true),
      'enemies.tidehunter.level': observed(11),
      'enemies.tidehunter.alive': observed(false),
      'enemies.tidehunter.respawnIn': observed(22),
      'enemies.crystal_maiden.level': observed(10),
      'enemies.crystal_maiden.alive': observed(true),
      'enemies.windranger.level': observed(10),
      'enemies.windranger.alive': observed(true),
      'enemies.zuus.level': observed(11),
      'enemies.zuus.alive': observed(true),
      // Fresh, aged, and low-confidence — the three cases `AgeFormatter` renders differently.
      'enemies.nevermore.area': observed('bot', { source: 'cv', confidence: 0.91, ageMs: 4000 }),
      'enemies.tidehunter.area': observed('top', { source: 'cv', confidence: 0.86, ageMs: 22_000 }),
      'enemies.crystal_maiden.area': observed('mid', {
        source: 'cv',
        confidence: 0.55,
        ageMs: 31_000,
      }),
      'derived.nextItem': observed({ item: 'diffusal2', inSeconds: 40 }),
      'derived.roshanWindowAt': observed(1010),
      'derived.nextRuneAt': observed(900),
      'derived.netWorthLead': observed(3100),
      'map.towers': observed([
        { id: 't1 mid', side: 'them', down: true },
        { id: 't1 top', side: 'us', down: false },
      ]),
    },
    unseen: ['windranger', 'zuus'] as HeroId[],
  });
}

describe('rendered snapshots', () => {
  it('draft phase', async () => {
    await expect(render(draftPhase())).toMatchFileSnapshot(
      '../../../../fixtures/golden/snapshot/draft.txt',
    );
  });

  it('laning phase', async () => {
    await expect(render(laning())).toMatchFileSnapshot(
      '../../../../fixtures/golden/snapshot/laning.txt',
    );
  });

  it('mid game', async () => {
    await expect(render(midGame())).toMatchFileSnapshot(
      '../../../../fixtures/golden/snapshot/mid-game.txt',
    );
  });

  it('mid game, under a tight budget', async () => {
    await expect(
      render(midGame(), { budget: { maxTokens: 225, spentTokens: 0 } }),
    ).toMatchFileSnapshot('../../../../fixtures/golden/snapshot/mid-game-truncated.txt');
  });
});

/**
 * The brief, golden. REPO_SKELETON.md §5.3, and coaching-architecture.md §13's Tier 2 row.
 *
 * > The format **is** the interface to the LLM, so a change to it should show up as a readable
 * > diff.
 *
 * Everything `coaching.test.ts` asserts is a *rule* — the plan is total, a stale fact carries its
 * age, the lead section survives. None of those catch the change that matters most in practice,
 * which is somebody making the text read differently. Prompt engineering is a format change by
 * another name (§14), and it should be reviewed the way a format change is: as a diff against a
 * committed expectation.
 *
 * **One world, five causes.** That is the whole point of the corpus and it is a different shape
 * from the snapshot's, which is four different worlds. `BRIEF_PLAN` is the thing under review here,
 * so holding the game fixed and varying only the reason for the turn makes the diff between two
 * fixtures *be* the plan row — which is exactly what a reviewer needs to see to judge whether a
 * given moment gets the right facts.
 *
 * One line reads oddly on first pass and is correct: `seen … tidehunter top unseen >20s(0.86)`. The
 * position is 22 seconds old, so `AgeFormatter` renders its age as the `unseen >Ns` marker, while
 * the `unseen` half of the line names only the heroes the world model reports as unseen. Both
 * halves say the same thing from different directions, and the fragment matches
 * `fixtures/golden/snapshot/mid-game.txt` exactly — which is the property worth having: one
 * `AgeFormatter`, two renderers, no drift about when to say "probably".
 */

import { describe, expect, it } from 'vitest';
import type { GameClock, HeroId, ItemId, MonoMs, TurnId } from '../common/types.js';
import type { AdviceTopic } from '../memory/types.js';
import type { BriefRequest } from './types.js';
import type { CoachingMemoryReader } from '../memory/contracts.js';
import { FakeWorldModel, observed } from '../testing/index.js';
import { DEFAULT_PRIVACY } from '../render/privacy.js';
import { createBriefRenderer } from './render.js';

const NOW = 60_000 as MonoMs;
const BKB: AdviceTopic = { of: 'item', item: 'black_king_bar' as ItemId };

/** Advice already given twice and ignored — the case `history` exists for. */
const REPEATED: CoachingMemoryReader = {
  recent: () => ({
    topic: BKB,
    firstAt: 700 as GameClock,
    lastAt: 812 as GameClock,
    count: 2,
    response: 'ignored',
  }),
  lastSpokeAt: () => 812 as GameClock,
  silentFor: () => 60,
};

const renderer = createBriefRenderer({ coaching: REPEATED });

/**
 * 14:32, five enemies, two of them unseen, one position aged past the confidence floor.
 *
 * Deliberately the same moment as `fixtures/golden/snapshot/mid-game.txt`, so the two corpora can
 * be read side by side: the snapshot is what the model gets every turn, and each brief below is
 * what it additionally gets for one specific thing worth saying.
 */
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
        { id: 'tricks_of_trade', cooldown: 4 },
        { id: 'smoke_screen', cooldown: 0 },
        { id: 'invis', cooldown: 0 },
      ]),
      'enemies.nevermore.ultimate': observed(
        { id: 'requiem', cooldown: 0 },
        { source: 'cv', confidence: 0.82, ageMs: 9_000 },
      ),
      'enemies.tidehunter.ultimate': observed({ id: 'ravage', cooldown: 41 }, { source: 'log' }),
      'enemies.nevermore.area': observed('bot', { source: 'cv', confidence: 0.91, ageMs: 4_000 }),
      'enemies.tidehunter.area': observed('top', { source: 'cv', confidence: 0.86, ageMs: 22_000 }),
      // Below the 0.5 floor: dropped, not hedged. Its absence from every fixture is the point.
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

function render(world: FakeWorldModel, over: Partial<BriefRequest> = {}): string {
  const brief = renderer.render(world.snapshot(NOW), {
    turnId: 'golden' as TurnId,
    cause: { by: 'player', gesture: 'push_to_talk' },
    now: NOW,
    budget: { maxTokens: 200, spentTokens: 0 },
    privacy: DEFAULT_PRIVACY,
    ...over,
  });

  // The committed artifact is the text *and* what was left out. A change that silently drops a
  // line would otherwise show up as a smaller diff than a change that reworded one.
  return [
    brief.text === '' ? '(empty — this turn does not happen)' : brief.text,
    '',
    `--- ${String(brief.tokens)} tokens${brief.empty ? ', empty' : ''}`,
    `--- omitted: ${brief.omitted.length === 0 ? '(none)' : brief.omitted.join(', ')}`,
    '',
  ].join('\n');
}

const DIR = '../../../../fixtures/golden/coaching';

describe('rendered briefs', () => {
  it('a player question — the widest brief there is', async () => {
    await expect(render(midGame())).toMatchFileSnapshot(`${DIR}/player-question.txt`);
  });

  it('enemy_missing', async () => {
    // Leads with `positions`, and carries both halves of it — `seen` and `unseen` are one section
    // here, so the pair the snapshot needs a `dropsWith` rule for cannot come apart.
    await expect(
      render(midGame(), {
        cause: { by: 'trigger', event: 'enemy_missing' as never, salience: 0.82 },
        topic: { of: 'event', event: 'enemy_missing' as never },
      }),
    ).toMatchFileSnapshot(`${DIR}/enemy-missing.txt`);
  });

  it('can_afford_key_item, raised for the third time', async () => {
    // **The diff worth reading in this corpus.** Same world, same budget, and the `history` line
    // is what a second mention adds: raised twice, ignored, say it differently or not at all.
    await expect(
      render(midGame(), {
        cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 0.55 },
        topic: BKB,
      }),
    ).toMatchFileSnapshot(`${DIR}/can-afford-key-item.txt`);
  });

  it('low_hp_no_escape, under a tight budget', async () => {
    // The shortest-lived thing Riki says, at a budget that forces the ladder to fire. `threat` is
    // the lead section and undroppable, so the brief still carries what the turn is about.
    await expect(
      render(midGame(), {
        cause: { by: 'trigger', event: 'low_hp_no_escape' as never, salience: 0.97 },
        budget: { maxTokens: 60, spentTokens: 0 },
      }),
    ).toMatchFileSnapshot(`${DIR}/low-hp-no-escape-truncated.txt`);
  });

  it('a cause whose sections are all empty — the turn that does not happen', async () => {
    // §6.5, as a fixture. The correct behaviour is a recorded silent turn, not an opened session
    // turn with an empty brief and a model left to improvise.
    const quiet = new FakeWorldModel({ clock: 120 as GameClock, roster: { enemies: [] } });
    await expect(
      render(quiet, { cause: { by: 'trigger', event: 'rune_soon' as never, salience: 0.4 } }),
    ).toMatchFileSnapshot(`${DIR}/empty.txt`);
  });
});

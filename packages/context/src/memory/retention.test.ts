/**
 * The retention ladder, the compactor, the summary and the rehydration brief. Tier 1.
 *
 * §13 names four properties here, and one of them is called out as the rule an implementation is
 * most likely to get wrong: **a dropped result always drops its call**. In this ledger that is
 * structural — one `command` entry holds both — so the test asserts the property in the form that
 * would catch someone splitting the entry in two later, which is the only way it can regress.
 */

import { describe, expect, it } from 'vitest';
import type { CallId, GameClock, ItemId, MatchId, MonoMs, TurnId } from '../common/types.js';
import type { AdviceTopic, WindowBudget } from './types.js';
import { FakeWorldModel, observed } from '../testing/index.js';
import { createTokenCounter } from '../render/tokens.js';
import { createConversationLedger } from './ledger.js';
import { createCoachingMemory } from './coaching.js';
import { createWorkingMemory } from './working.js';
import { createRetentionPolicy } from './retention.js';
import { createSummaryRenderer } from './summary.js';
import { createCompactor } from './compactor.js';
import { createRehydrator } from './rehydrate.js';

const MATCH = 'm1' as MatchId;
const counter = createTokenCounter();
const BKB: AdviceTopic = { of: 'item', item: 'black_king_bar' as ItemId };

/** A budget small enough that a handful of turns crosses it, so a test is a few lines. */
const BUDGET: WindowBudget = {
  capTokens: 2_000,
  lowWaterMark: 0.75,
  targetAfter: 0.55,
  keepLastTurns: 2,
};

function match(turns: number) {
  const ledger = createConversationLedger(MATCH);
  for (let i = 0; i < turns; i += 1) {
    const turnId = `t${String(i)}` as TurnId;
    const at = (i * 1000) as MonoMs;
    ledger.append({
      kind: 'turn_opened',
      turnId,
      cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 0.6 },
      at,
      clock: (600 + i * 60) as GameClock,
    });
    ledger.append({
      kind: 'snapshot',
      turnId,
      rendered: { text: `T ${String(i)}`, tokens: 300 },
      sections: [],
      at,
    });
    ledger.append({
      kind: 'command',
      turnId,
      callId: `c${String(i)}` as CallId,
      name: 'get_enemy_detail',
      result: { text: 'sf bot 4s ago', tokens: 120 },
      status: 'ok',
      at,
    });
    ledger.append({
      kind: 'agent_said',
      turnId,
      transcript: 'they are pushing bot, back off',
      topics: [BKB],
      at,
    });
    ledger.append({ kind: 'turn_closed', turnId, outcome: 'spoke', at });
  }
  return ledger;
}

const retention = createRetentionPolicy({ counter });

describe('RetentionPolicy', () => {
  it('drops command results before anything else', () => {
    const ledger = match(4);
    const plan = retention.plan(ledger, BUDGET, 0 as MonoMs);
    const kinds = plan.drop.map((ref) => ledger.entry(ref)?.kind);
    expect(kinds[0]).toBe('command');
    // Riki's own injection goes before anything anybody said (§7.1).
    expect(kinds).not.toContain('agent_said');
  });

  it('never drops a command result without its call — they are one entry', () => {
    // The vacuum the command architecture's one-result invariant prevents, reintroduced by
    // retention. Here it cannot happen because a `command` entry *is* the pair; if that ever
    // becomes two entries, this assertion is what fails.
    const ledger = match(6);
    const plan = retention.plan(ledger, BUDGET, 0 as MonoMs);
    for (const ref of plan.drop) {
      const entry = ledger.entry(ref);
      if (entry?.kind !== 'command') continue;
      expect(entry.name).not.toBe('');
      expect(entry.result).toBeDefined();
    }
  });

  it('keeps the most recent snapshot and the current turn’s commands', () => {
    const ledger = match(6);
    const inWindow = ledger.inWindow();
    const newestSnapshot = [...inWindow]
      .reverse()
      .find((r) => ledger.entry(r)?.kind === 'snapshot');
    const currentTurn = ledger.entry(inWindow[inWindow.length - 1]!);

    const plan = retention.plan(ledger, BUDGET, 0 as MonoMs);
    expect(plan.drop).not.toContain(newestSnapshot);
    for (const ref of plan.drop) {
      const entry = ledger.entry(ref);
      if (entry?.kind === 'command' && currentTurn?.kind !== 'summary') {
        expect(entry.turnId).not.toBe(currentTurn?.turnId);
      }
    }
  });

  it('never drops the last keepLastTurns turns of conversation', () => {
    const ledger = match(8);
    const plan = retention.plan(ledger, { ...BUDGET, capTokens: 300 }, 0 as MonoMs);
    const spoken = plan.drop
      .map((ref) => ledger.entry(ref))
      .filter((e) => e?.kind === 'agent_said' || e?.kind === 'player_said');
    expect(spoken).toHaveLength(0);
  });

  it('replaces old conversation with a rendered summary only when that is cheaper', () => {
    const world = new FakeWorldModel({
      clock: 900 as GameClock,
      facts: {
        'self.kda': observed({ kills: 4, deaths: 1, assists: 3 }),
        'derived.netWorthLead': observed(3100),
      },
    });
    const summary = createSummaryRenderer();
    const policy = createRetentionPolicy({
      counter,
      summarise: (entries) => summary.render(entries, world, { maxTokens: 200, spentTokens: 0 }),
    });

    const ledger = match(10);
    const plan = policy.plan(ledger, { ...BUDGET, capTokens: 900 }, 0 as MonoMs);
    expect(plan.replace).toHaveLength(1);
    const [replacement] = plan.replace;
    const replacedTokens = (replacement?.refs ?? []).length;
    expect(replacedTokens).toBeGreaterThan(0);
    expect(replacement?.with.tokens).toBeLessThan(replacedTokens * 40);
  });

  it('says `forced` above the cap and `low_water` below it', () => {
    const ledger = match(4);
    expect(retention.plan(ledger, { ...BUDGET, capTokens: 100 }, 0 as MonoMs).reason).toBe(
      'forced',
    );
    expect(retention.plan(ledger, BUDGET, 0 as MonoMs).reason).toBe('low_water');
  });
});

describe('Compactor', () => {
  function setup(turns: number, budget: WindowBudget = BUDGET) {
    const ledger = match(turns);
    const coaching = createCoachingMemory(ledger);
    const working = createWorkingMemory(ledger, coaching, counter);
    const compactor = createCompactor({ ledger, working, retention, budget });
    return { ledger, working, compactor };
  }

  it('returns nothing below the low-water mark', () => {
    // Not when the window is full, and not before: every truncation busts the prompt cache, and a
    // cache bust is a latency cost that lands on the player as a slow answer.
    const { compactor } = setup(1);
    const quiet = new FakeWorldModel({ facts: { 'derived.teamfightIntensity': observed(0) } });
    expect(compactor.consider(quiet.snapshot(0 as MonoMs), 0 as MonoMs)).toBeNull();
  });

  it('waits for a quiet moment above the low-water mark', () => {
    const { compactor } = setup(4);
    const fighting = new FakeWorldModel({
      facts: { 'derived.teamfightIntensity': observed(0.9) },
    });
    expect(compactor.consider(fighting.snapshot(0 as MonoMs), 0 as MonoMs)).toBeNull();

    const quiet = new FakeWorldModel({ facts: { 'derived.teamfightIntensity': observed(0.05) } });
    expect(compactor.consider(quiet.snapshot(0 as MonoMs), 0 as MonoMs)?.reason).toBe(
      'quiet_moment',
    );
  });

  it('plans during a teamfight once the cap is reached', () => {
    // A cache bust during a fight still beats the API truncating oldest-first, which takes the
    // cached prefix: Riki would forget who it is before it forgot its own small talk.
    const { compactor } = setup(4, { ...BUDGET, capTokens: 400 });
    const fighting = new FakeWorldModel({ facts: { 'derived.teamfightIntensity': observed(0.9) } });
    expect(compactor.consider(fighting.snapshot(0 as MonoMs), 0 as MonoMs)?.reason).toBe('forced');
  });

  it('records what realtime actually dropped, not what the plan asked for', () => {
    const { ledger, compactor, working } = setup(4);
    const quiet = new FakeWorldModel({ facts: { 'derived.teamfightIntensity': observed(0) } });
    const plan = compactor.consider(quiet.snapshot(0 as MonoMs), 5_000 as MonoMs);
    expect(plan).not.toBeNull();

    // `AppliedWindowPlan.failed` is a real case: recording the plan would put a divergence into
    // `inWindow()` that nothing later could detect.
    const [first] = plan!.drop;
    compactor.applied(plan!, [first!]);

    expect(ledger.inWindow()).not.toContain(first);
    expect(ledger.inWindow()).toContain(plan!.drop[1]);
    expect(working.window().lastCompactedAt).toBe(5_000);
  });
});

describe('SummaryRenderer', () => {
  it('is deterministic for the same ledger and world', () => {
    const world = new FakeWorldModel({
      clock: 900 as GameClock,
      facts: {
        'self.kda': observed({ kills: 4, deaths: 1, assists: 3 }),
        'self.netWorth': observed(12_400),
        'derived.netWorthLead': observed(3100),
      },
    });
    const summary = createSummaryRenderer();
    const entries = match(3).all();
    const budget = { maxTokens: 200, spentTokens: 0 };

    const first = summary.render(entries, world, budget);
    expect(summary.render(entries, world, budget)).toStrictEqual(first);
    expect(first.text).toContain('you 4/1/3');
    // Rendered, not generated: it cannot invent a kill, because there is no model in the loop.
    expect(first.text).toContain('advised: black_king_bar×3');
  });
});

describe('Rehydrator', () => {
  it('carries every advice topic already raised — the "does not repeat itself" property', () => {
    const ledger = match(3);
    const world = new FakeWorldModel({
      clock: 900 as GameClock,
      facts: { 'self.kda': observed({ kills: 4, deaths: 1, assists: 3 }) },
    });
    const brief = createRehydrator({ summary: createSummaryRenderer() }).brief(
      ledger,
      world.snapshot(0 as MonoMs),
      { maxTokens: 400, spentTokens: 0 },
    );

    expect(brief.text).toContain('already advised: black_king_bar');
    expect(brief.text).toContain('do not repeat');
    expect(brief.text).toContain('session resumed');
  });

  it('keeps the advice list even when the budget is too small for the gist', () => {
    const ledger = match(6);
    const world = new FakeWorldModel({ clock: 900 as GameClock });
    const brief = createRehydrator({ summary: createSummaryRenderer() }).brief(
      ledger,
      world.snapshot(0 as MonoMs),
      { maxTokens: 30, spentTokens: 0 },
    );
    expect(brief.text).toContain('already advised');
    expect(brief.text).not.toContain('last exchanges');
  });
});

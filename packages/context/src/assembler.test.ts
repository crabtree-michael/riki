/**
 * `ContextAssembler` — the seam the rest of the voice assistant consumes. Tier 1.
 *
 * These are the integration points §9.1 lists, exercised the way their counterparts will use them,
 * with no session, no game and no network:
 *
 * - `packages/events` opens a turn and reads `coaching` (§9.3) — and reads *only* that: three
 *   methods about advice, and nothing about tokens, the window, or a `LedgerEntry`.
 * - The composition root's session adapter appends transcripts through `ledger` (§9.4) and hands
 *   back what `packages/realtime` actually dropped (§7.6).
 * - `packages/realtime` receives a `WindowPlan` as a value, never a series of calls (§1.2).
 *
 * The end-to-end property worth stating: **a turn's cause, its snapshot, its brief and what was
 * said all land in one ledger, and the projections over that ledger survive a compaction.** That is
 * the whole of ADR-0012 in one test.
 */

import { describe, expect, it } from 'vitest';
import type { GameClock, HeroId, ItemId, MatchId, MonoMs, TurnId } from './common/types.js';
import type { AdviceTopic, WindowPlan } from './memory/types.js';
import { FakeWorldModel, observed } from './testing/index.js';
import { FakeEventTape, RecordingContextTelemetry } from './testing/index.js';
import { EMPTY_PLAYER_MEMORY } from './memory/player-memory.js';
import { createPreambleAssembler } from './preamble/assemble.js';
import { FakeReferenceData } from './testing/index.js';
import { createContextAssembler } from './assembler.js';

const RIKI = 'riki' as HeroId;
const BKB: AdviceTopic = { of: 'item', item: 'black_king_bar' as ItemId };

function world(): FakeWorldModel {
  return new FakeWorldModel({
    clock: 872 as GameClock,
    roster: { self: RIKI, enemies: ['nevermore', 'tidehunter'] as HeroId[] },
    facts: {
      'self.hero': observed(RIKI),
      'self.level': observed(11),
      'self.hpPct': observed(84),
      'self.gold': observed(1840),
      'self.kda': observed({ kills: 4, deaths: 1, assists: 3 }),
      'enemies.nevermore.level': observed(12),
      'enemies.nevermore.alive': observed(true),
      'derived.teamfightIntensity': observed(0),
    },
  });
}

function assembler(overrides: Partial<Parameters<typeof createContextAssembler>[0]> = {}) {
  return createContextAssembler({
    matchId: 'm1' as MatchId,
    world: world(),
    preamble: createPreambleAssembler({
      reference: new FakeReferenceData(),
      persona: 'You are Riki.',
    }),
    ...overrides,
  });
}

describe('openSession', () => {
  it('sums persona and preamble against the prefix cap, with no manifest part', async () => {
    const context = assembler();
    const session = await context.openSession(
      {
        matchId: 'm1' as MatchId,
        draft: { self: RIKI, allies: [], enemies: ['nevermore'] as HeroId[] },
        player: { hero: RIKI, role: 'carry', lane: 'safe', bracket: null },
        patch: '7.39c',
        memory: EMPTY_PLAYER_MEMORY,
      },
      0 as MonoMs,
    );

    expect(session.prefix.check().ok).toBe(true);
    // coaching-architecture.md §8.1: the 2,000-token manifest part is gone, and a part that
    // reappears here is a tool surface that has grown back.
    expect(session.prefix.parts.has('manifest')).toBe(false);
    expect(
      [...session.prefix.parts.keys()].every((k) => k === 'persona' || k.startsWith('preamble.')),
    ).toBe(true);
    expect(session.preamble.text).toContain('You are Riki.');
  });
});

describe('one turn, end to end', () => {
  it('records the cause, the snapshot and what was said, in one ledger', () => {
    const tape = new FakeEventTape();
    tape.push({ id: 'enemy_missing' as never, at: 860 as GameClock, text: 'sf missing 12s' });
    const context = assembler({ tape });

    const turn = context.openTurn(
      {
        turnId: 't0' as TurnId,
        cause: { by: 'trigger', event: 'enemy_missing' as never, salience: 0.7 },
      },
      1_000 as MonoMs,
    );
    expect(turn.snapshot.text).toContain('T 14:32');
    expect(turn.snapshot.text).toContain('sf missing 12s');
    expect(turn.remaining.maxTokens).toBeGreaterThan(0);

    // The brief is the focused half, and it is rendered in the same synchronous call as the
    // snapshot — one turn, one <5 ms budget, nothing awaited (coaching-architecture.md §5.5).
    expect(turn.brief.turnId).toBe('t0');
    expect(turn.brief.empty).toBe(false);
    expect(turn.brief.text).toContain('threat: hp 84%');
    // `enemy_missing` asks for `positions` first, and this world model holds no positions — so the
    // lead section is *absent* rather than empty, and `omitted` says which of the two happened.
    expect(turn.brief.omitted).toContain('positions');

    context.ledger.append({
      kind: 'agent_said',
      turnId: 't0' as TurnId,
      transcript: 'sf has been gone twelve seconds — pull back',
      topics: [{ of: 'event', event: 'enemy_missing' as never }],
      at: 1_500 as MonoMs,
    });
    context.closeTurn('t0' as TurnId, 'spoke', 2_000 as MonoMs);

    const kinds = context.ledgerRecord.all().map((e) => e.kind);
    expect(kinds).toStrictEqual(['turn_opened', 'snapshot', 'brief', 'agent_said', 'turn_closed']);
  });

  it('renders an empty brief rather than refusing, and says so', () => {
    // §6.5: a brief that renders nothing is a turn that should not happen — but this object cannot
    // refuse to open one, because `packages/events` already admitted it. It reports `empty` and
    // leaves the composition root to close the turn silent. Nothing is appended for an empty
    // brief: a zero-token entry would make "had nothing to say" and "said nothing about it" look
    // the same in the ledger.
    const context = assembler({
      world: new FakeWorldModel({ facts: {}, roster: { enemies: [] } }),
    });
    const turn = context.openTurn(
      { turnId: 't0' as TurnId, cause: { by: 'system', reason: 'match_started' } },
      0 as MonoMs,
    );

    expect(turn.brief.empty).toBe(true);
    expect(turn.brief.omitted.length).toBeGreaterThan(0);
    expect(context.ledgerRecord.all().map((e) => e.kind)).not.toContain('brief');
  });

  it('passes the trigger topic through to the brief — coaching §6.6 row 4', () => {
    // One value, one origin, three consumers. The composition root holds the whole `CoachEvent`,
    // so the topic arrives on `openTurn` rather than being re-derived from the event id through a
    // second table that can disagree with the novelty gate's.
    const context = assembler();
    const turn = context.openTurn(
      {
        turnId: 't0' as TurnId,
        cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 0.6 },
        topic: BKB,
      },
      0 as MonoMs,
    );
    // Nothing has been said yet, so there is no history line — which is the observable proof the
    // topic reached the planner rather than being dropped on the way.
    expect(turn.brief.text).not.toContain('history:');

    context.ledger.append({
      kind: 'agent_said',
      turnId: 't0' as TurnId,
      transcript: 'you can afford a bkb',
      topics: [BKB],
      at: 0 as MonoMs,
    });
    const second = context.openTurn(
      {
        turnId: 't1' as TurnId,
        cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 0.6 },
        topic: BKB,
      },
      1_000 as MonoMs,
    );
    expect(second.brief.text).toContain('raised 1× on this');
  });

  it('records a suppressed turn, which is what makes silence something anyone can notice', () => {
    // `packages/events` decides not to speak far more often than it decides to speak (dota2 §6.4).
    const context = assembler();
    context.openTurn(
      { turnId: 't0' as TurnId, cause: { by: 'system', reason: 'match_started' } },
      0 as MonoMs,
    );
    context.closeTurn('t0' as TurnId, 'silent', 100 as MonoMs);

    const closed = context.ledgerRecord.all().at(-1);
    expect(closed).toMatchObject({ kind: 'turn_closed', outcome: 'silent' });
    expect(context.working.outcomeOf('t0' as TurnId)).toBe('silent');
  });

  it('reports render and truncation to telemetry rather than to console', () => {
    const telemetry = new RecordingContextTelemetry();
    const context = assembler({ telemetry, snapshotTokens: 40 });
    context.openTurn(
      { turnId: 't0' as TurnId, cause: { by: 'player', gesture: 'push_to_talk' } },
      0 as MonoMs,
    );

    expect(telemetry.renders.map((r) => r.tier)).toStrictEqual(['snapshot', 'brief']);
    expect(telemetry.truncations[0]?.tier).toBe('snapshot');
  });
});

describe('the events seam', () => {
  it('exposes advice and nothing else', () => {
    // §9.3: three methods, no mutation, no ledger, no tokens. Giving the salience path a reason to
    // know about tokens is the inversion this edge exists to refuse (coaching §4.4).
    const context = assembler();
    expect(Object.keys(context.coaching).sort()).toStrictEqual([
      'all',
      'lastSpokeAt',
      'observeOutcome',
      'recent',
      'silentFor',
    ]);
    expect(context.coaching.recent(BKB, 100)).toBeUndefined();
  });

  it('lets the novelty gate see advice already given', () => {
    const context = assembler();
    context.openTurn(
      {
        turnId: 't0' as TurnId,
        cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 1 },
      },
      0 as MonoMs,
    );
    context.ledger.append({
      kind: 'agent_said',
      turnId: 't0' as TurnId,
      transcript: 'you can afford a bkb',
      topics: [BKB],
      at: 0 as MonoMs,
    });

    expect(context.coaching.recent(BKB, 600)?.count).toBe(1);
    expect(context.coaching.lastSpokeAt()).toBe(872);
  });
});

describe('the realtime seam', () => {
  function busyMatch() {
    const plans: WindowPlan[] = [];
    const context = assembler({
      windowBudget: { capTokens: 1_200, lowWaterMark: 0.75, targetAfter: 0.55, keepLastTurns: 2 },
      onWindowPlan: (plan) => plans.push(plan),
    });

    for (let i = 0; i < 6; i += 1) {
      const turnId = `t${String(i)}` as TurnId;
      const at = (i * 1_000) as MonoMs;
      context.openTurn({ turnId, cause: { by: 'player', gesture: 'push_to_talk' } }, at);
      context.ledger.append({
        kind: 'brief',
        turnId,
        rendered: { text: 'threat: sf bot 4s ago(0.91)', tokens: 120 },
        sections: ['threat'],
        at,
      });
      context.closeTurn(turnId, 'spoke', at);
    }
    return { context, plans };
  }

  it('produces a plan as a value, and drops our own artifacts before the conversation', () => {
    const { context, plans } = busyMatch();
    expect(plans.length).toBeGreaterThan(0);

    const plan = plans.at(-1)!;
    const kinds = plan.drop.map((ref) => context.ledgerRecord.entry(ref)?.kind);
    // Superseded briefs first, and the conversation not at all — Riki's own injection is the
    // larger half of the tokens a minute (§7.1), and it is the half we can economise.
    expect(kinds[0]).toBe('brief');
    expect(kinds).not.toContain('agent_said');
    expect(kinds).not.toContain('player_said');
    expect(plan.estimatedTokensAfter).toBeLessThan(1_200);

    // The plan crosses as a value; applying it is a separate call, with what realtime *actually*
    // dropped rather than what was asked for (§8.4).
    context.applyWindowPlan(plan, plan.drop);
    for (const ref of plan.drop) expect(context.ledgerRecord.inWindow()).not.toContain(ref);
  });

  it('reconciles an API-initiated truncation as a bug, not a condition', () => {
    // §7.6: a non-zero `api_truncation` count means the low-water mark or the counter is wrong.
    const telemetry = new RecordingContextTelemetry();
    const context = assembler({ telemetry });
    context.openTurn(
      { turnId: 't0' as TurnId, cause: { by: 'player', gesture: 'push_to_talk' } },
      0 as MonoMs,
    );

    const [first] = context.ledgerRecord.inWindow();
    context.noteDropped([first!], 'api_truncation');

    expect(context.ledgerRecord.dropped().api_truncation).toBe(1);
    expect(telemetry.drifts).toHaveLength(1);
  });
});

describe('rehydrate', () => {
  it('briefs a new session on advice already given', async () => {
    const context = assembler();
    context.openTurn(
      {
        turnId: 't0' as TurnId,
        cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 1 },
      },
      0 as MonoMs,
    );
    context.ledger.append({
      kind: 'agent_said',
      turnId: 't0' as TurnId,
      transcript: 'you can afford a bkb',
      topics: [BKB],
      at: 0 as MonoMs,
    });

    const brief = await context.rehydrate(1_000 as MonoMs);
    expect(brief.text).toContain('already advised: black_king_bar');
    expect(brief.text).toContain('do not repeat');
  });
});

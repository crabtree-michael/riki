/**
 * `ContextAssembler` — the seam the rest of the voice assistant consumes. Tier 1.
 *
 * These are the integration points §9.1 lists, exercised the way their counterparts will use them,
 * with no session, no game and no network:
 *
 * - `packages/events` opens a turn and reads `coaching` (§9.3) — and reads *only* that: three
 *   methods about advice, and nothing about tokens, the window, or a `LedgerEntry`.
 * - The composition root's session adapter appends transcripts and command results through
 *   `ledger` (§9.4) and hands back what `packages/realtime` actually dropped (§7.6).
 * - `packages/realtime` receives a `WindowPlan` as a value, never a series of calls (§1.2).
 *
 * The end-to-end property worth stating: **a turn's snapshot, its transcripts and its commands all
 * land in one ledger, and the projections over that ledger survive a compaction.** That is the
 * whole of ADR-0012 in one test.
 */

import { describe, expect, it } from 'vitest';
import type { GameClock, HeroId, ItemId, MatchId, MonoMs, TurnId } from './common/types.js';
import type { AdviceTopic, WindowPlan } from './memory/types.js';
import type { ToolManifest } from './tools/contracts.js';
import { FakeWorldModel, observed } from './tools/testing/index.js';
import { FakeEventTape, RecordingContextTelemetry } from './testing/index.js';
import { EMPTY_PLAYER_MEMORY } from './memory/player-memory.js';
import { createPreambleAssembler } from './preamble/assemble.js';
import { FakeReferenceData } from './tools/testing/index.js';
import { createContextAssembler } from './assembler.js';

const RIKI = 'riki' as HeroId;
const BKB: AdviceTopic = { of: 'item', item: 'black_king_bar' as ItemId };

const MANIFEST: ToolManifest = { tools: [], estimatedTokens: 1_800, frozenAt: 0 as MonoMs };

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
    manifest: MANIFEST,
    ...overrides,
  });
}

describe('openSession', () => {
  it('sums persona, preamble and manifest against the prefix cap', async () => {
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
    expect(session.prefix.parts.get('manifest')).toBe(1_800);
    expect(session.preamble.text).toContain('You are Riki.');
  });
});

describe('one turn, end to end', () => {
  it('records the cause, the snapshot, what was said and what ran, in one ledger', () => {
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

    context.ledger.append({
      kind: 'agent_said',
      turnId: 't0' as TurnId,
      transcript: 'sf has been gone twelve seconds — pull back',
      topics: [{ of: 'event', event: 'enemy_missing' as never }],
      at: 1_500 as MonoMs,
    });
    context.closeTurn('t0' as TurnId, 'spoke', 2_000 as MonoMs);

    const kinds = context.ledgerRecord.all().map((e) => e.kind);
    expect(kinds).toStrictEqual(['turn_opened', 'snapshot', 'agent_said', 'turn_closed']);
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

    expect(telemetry.renders.map((r) => r.tier)).toStrictEqual(['snapshot']);
    expect(telemetry.truncations[0]?.tier).toBe('snapshot');
  });
});

describe('the events seam', () => {
  it('exposes advice and nothing else', () => {
    // §9.3: three methods, no mutation, no ledger, no tokens. Giving the salience path a reason to
    // know about tokens is the inversion the command architecture refused for commands.
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
        kind: 'command',
        turnId,
        callId: `c${String(i)}` as never,
        name: 'get_enemy_detail',
        result: { text: 'sf bot 4s ago(0.91)', tokens: 120 },
        status: 'ok',
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
    // Command results first, and the conversation not at all — Riki's own injection is ~500 of the
    // ~750 tokens a minute (§7.1), and it is the half we can economise.
    expect(kinds[0]).toBe('command');
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

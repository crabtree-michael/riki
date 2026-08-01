/**
 * The ledger, working memory and coaching memory. Tier 1 (REPO_SKELETON.md §5.3).
 *
 * §13's rows: append/since/version; `markDropped` updates `inWindow` without mutating entries; the
 * projection memoises against `version()`; and **a compaction does not change any `AdviceRecord`**
 * — which is the executable form of ADR-0012's whole argument. If that last one ever fails, the
 * novelty gate has started forgetting, and dota2 §6.4 names unprompted repetition as the failure
 * most likely to make Riki annoying enough to uninstall.
 */

import { describe, expect, it } from 'vitest';
import type { GameClock, ItemId, MatchId, MonoMs, TurnId } from '../common/types.js';
import type { AdviceTopic, LedgerRef } from './types.js';
import { FakeWorldModel, observed } from '../testing/index.js';
import { createTokenCounter } from '../render/tokens.js';
import { createConversationLedger } from './ledger.js';
import { createCoachingMemory } from './coaching.js';
import { createWorkingMemory } from './working.js';
import { entryTokens, speechTokens } from './occupancy.js';

const MATCH = 'm1' as MatchId;
const BKB: AdviceTopic = { of: 'item', item: 'black_king_bar' as ItemId };
const ROSHAN: AdviceTopic = { of: 'objective', objective: 'roshan' };

function ledgerWithTurns(count: number, topic: AdviceTopic = BKB) {
  const ledger = createConversationLedger(MATCH);
  for (let i = 0; i < count; i += 1) {
    const turnId = `t${String(i)}` as TurnId;
    ledger.append({
      kind: 'turn_opened',
      turnId,
      cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 0.6 },
      at: (i * 1000) as MonoMs,
      clock: (600 + i * 60) as GameClock,
    });
    ledger.append({
      kind: 'snapshot',
      turnId,
      rendered: { text: `snapshot ${String(i)}`, tokens: 300 },
      sections: [],
      at: (i * 1000) as MonoMs,
    });
    ledger.append({
      kind: 'agent_said',
      turnId,
      transcript: 'you can afford a bkb',
      topics: [topic],
      at: (i * 1000) as MonoMs,
    });
    ledger.append({ kind: 'turn_closed', turnId, outcome: 'spoke', at: (i * 1000) as MonoMs });
  }
  return ledger;
}

describe('ConversationLedger', () => {
  it('appends, reads back in order, and bumps its version', () => {
    const ledger = createConversationLedger(MATCH);
    const before = ledger.version();
    const ref = ledger.append({
      kind: 'player_said',
      turnId: 't0' as TurnId,
      transcript: 'should I go rosh',
      at: 0 as MonoMs,
    });
    expect(ledger.entry(ref)?.kind).toBe('player_said');
    expect(ledger.since(0 as LedgerRef)).toHaveLength(1);
    expect(ledger.version()).toBeGreaterThan(before);
  });

  it('never puts bookkeeping in the window', () => {
    // `turn_opened` and `turn_closed` are things Riki records about itself. Counting them as
    // occupancy would manufacture the very drift §7.6 exists to detect.
    const ledger = ledgerWithTurns(1);
    const kinds = ledger.inWindow().map((ref) => ledger.entry(ref)?.kind);
    expect(kinds).toStrictEqual(['snapshot', 'agent_said']);
  });

  it('marks refs dropped without mutating a single entry', () => {
    const ledger = ledgerWithTurns(2);
    const before = structuredClone(ledger.all());
    const [first] = ledger.inWindow();

    ledger.markDropped([first!], 'planned');

    expect(ledger.inWindow()).not.toContain(first);
    expect(ledger.all()).toStrictEqual(before);
    expect(ledger.dropped().planned).toBe(1);
    expect(ledger.dropReason(first!)).toBe('planned');
  });

  it('does not bump its version for a drop it already knows about', () => {
    // `packages/realtime` may confirm a plan this component already applied. A projection
    // recomputing for that is pure waste.
    const ledger = ledgerWithTurns(1);
    const [first] = ledger.inWindow();
    ledger.markDropped([first!], 'planned');
    const version = ledger.version();
    ledger.markDropped([first!], 'planned');
    expect(ledger.version()).toBe(version);
  });
});

describe('CoachingMemory', () => {
  it('records the topic from the trigger, not from the text', () => {
    const ledger = ledgerWithTurns(2, ROSHAN);
    const coaching = createCoachingMemory(ledger);
    const record = coaching.recent(ROSHAN, 1000);
    expect(record?.count).toBe(2);
    // The transcript says "bkb"; the topic is the objective the trigger named. Nothing here
    // classifies natural language.
    expect(coaching.recent(BKB, 1000)).toBeUndefined();
  });

  it('memoises against version(), and a compaction changes no record', () => {
    // ADR-0012's argument, executable. Compaction changes what the *model* can see; it does not
    // change what happened, so the gate is correct across one.
    const ledger = ledgerWithTurns(3);
    const coaching = createCoachingMemory(ledger);
    const before = coaching.all();
    expect(before).toHaveLength(1);

    ledger.markDropped(ledger.inWindow(), 'planned');

    expect(coaching.all()).toStrictEqual(before);
    expect(coaching.recent(BKB, 10_000)?.count).toBe(3);
  });

  it('ages `recent` in game clock, from the latest clock the ledger knows', () => {
    const ledger = ledgerWithTurns(3);
    const coaching = createCoachingMemory(ledger);
    // Last advice at 720; latest clock is 720, so any window matches...
    expect(coaching.recent(BKB, 1)).toBeDefined();

    ledger.append({
      kind: 'turn_opened',
      turnId: 'later' as TurnId,
      cause: { by: 'player', gesture: 'push_to_talk' },
      at: 99_000 as MonoMs,
      clock: 1500 as GameClock,
    });
    // ...and once thirteen minutes have passed, a 60-second novelty window does not.
    expect(coaching.recent(BKB, 60)).toBeUndefined();
    expect(coaching.recent(BKB, 1000)).toBeDefined();
  });

  it('reports silence from the first clock when Riki has never spoken', () => {
    // "Riki has been quiet for nine minutes" has to be true on a match where it said nothing —
    // which is exactly the match where somebody should notice.
    const ledger = createConversationLedger(MATCH);
    ledger.append({
      kind: 'turn_opened',
      turnId: 't0' as TurnId,
      cause: { by: 'system', reason: 'match_started' },
      at: 0 as MonoMs,
      clock: 0 as GameClock,
    });
    ledger.append({
      kind: 'turn_closed',
      turnId: 't0' as TurnId,
      outcome: 'silent',
      at: 0 as MonoMs,
    });

    const coaching = createCoachingMemory(ledger);
    expect(coaching.lastSpokeAt()).toBeNull();
    expect(coaching.silentFor(540 as GameClock)).toBe(540);
  });

  it('observes whether advice was followed in the world model, not in the conversation', () => {
    const ledger = ledgerWithTurns(1);
    const coaching = createCoachingMemory(ledger);
    const record = coaching.all()[0];
    expect(record).toBeDefined();

    const bought = new FakeWorldModel({
      clock: 700 as GameClock,
      facts: { 'self.items': observed([{ id: 'black_king_bar' }]) },
    });
    expect(coaching.observeOutcome(record!, bought.snapshot(0 as MonoMs), 0 as MonoMs)).toBe(
      'followed',
    );

    // Same advice, no item, and the follow window has passed: gold went elsewhere.
    const ignored = new FakeWorldModel({
      clock: 800 as GameClock,
      facts: { 'self.items': observed([{ id: 'phase' }]) },
    });
    expect(coaching.observeOutcome(record!, ignored.snapshot(0 as MonoMs), 0 as MonoMs)).toBe(
      'ignored',
    );

    // And within the window it is still open, not a verdict.
    const pending = new FakeWorldModel({
      clock: 640 as GameClock,
      facts: { 'self.items': observed([{ id: 'phase' }]) },
    });
    expect(coaching.observeOutcome(record!, pending.snapshot(0 as MonoMs), 0 as MonoMs)).toBe(
      'unknown',
    );
  });
});

describe('WorkingMemory', () => {
  const counter = createTokenCounter();

  it('returns no elision base by default — §5.3 is the argument', () => {
    const ledger = ledgerWithTurns(1);
    const working = createWorkingMemory(ledger, createCoachingMemory(ledger), counter);
    expect(working.elisionBase()).toBeNull();
  });

  it('drops the elision base the moment the ledger stops believing it is in the window', () => {
    const ledger = createConversationLedger(MATCH);
    const working = createWorkingMemory(ledger, createCoachingMemory(ledger), counter, {
      elision: true,
    });
    const ref = ledger.append({
      kind: 'snapshot',
      turnId: 't0' as TurnId,
      rendered: { text: 'T 10:00', tokens: 5 },
      sections: [],
      at: 0 as MonoMs,
    });
    working.recordSnapshot(
      {
        turnId: 't0' as TurnId,
        text: 'T 10:00',
        tokens: 5,
        sections: [],
        truncated: false,
        omitted: [],
      },
      ref,
      600 as GameClock,
    );
    expect(working.elisionBase()?.clock).toBe(600);

    // No invalidation call anywhere: the base is a lookup, so compaction is enough (§10).
    ledger.markDropped([ref], 'planned');
    expect(working.elisionBase()).toBeNull();
  });

  it('costs an utterance as audio rather than as its transcript', () => {
    // realtime §5 prices assistant audio at ~1,200 tokens/minute. A ledger that costed speech by
    // its text would believe the window far emptier than it is, and would find out when the API
    // truncated the cached prefix.
    const transcript = 'you can afford a black king bar right now';
    expect(speechTokens(transcript, counter)).toBeGreaterThan(counter.count(transcript));
    expect(
      entryTokens(
        { kind: 'turn_closed', turnId: 't' as TurnId, outcome: 'silent', at: 0 as MonoMs },
        counter,
      ),
    ).toBe(0);
  });

  it('sums occupancy over what it believes is visible', () => {
    const ledger = ledgerWithTurns(2);
    const working = createWorkingMemory(ledger, createCoachingMemory(ledger), counter);
    const full = working.window().estimatedTokens;
    expect(full).toBeGreaterThan(600);

    ledger.markDropped(ledger.inWindow().slice(0, 1), 'planned');
    expect(working.window().estimatedTokens).toBe(full - 300);
  });
});

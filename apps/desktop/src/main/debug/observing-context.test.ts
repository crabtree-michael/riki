/**
 * The context decorator, and the assumption it rests on.
 *
 * `observeContext` is spread-and-override, which is correct only while `createContextAssembler`
 * returns a plain record of own enumerable members. The first test here is what turns that from a
 * comment into something the suite fails on — a getter or a prototype method added to `RikiContext`
 * would break the wrap silently otherwise, and the failure would be a member that quietly stopped
 * working only when the inspector was on.
 */

import { describe, expect, it } from 'vitest';

import type { EventId, MatchId, RikiContext, TurnId } from '@riki/context';
import { createContextAssembler, createPreambleAssembler } from '@riki/context';
import { buildWorld } from '@riki/events/testing';
import type { FieldPath, MonoMs } from '@riki/world-model';

import { NULL_REFERENCE_DATA } from '../shell/telemetry.js';
import { toContextReader } from '../agent/index.js';
import type { DebugTurnOpenedInput } from './contracts.js';
import { observeContext } from './observing-context.js';

function realContext(): RikiContext {
  const world = buildWorld({ now: 1_000, clock: 600 })
    .put('meta.phase' as FieldPath, 'in_progress')
    .put('self.hero' as FieldPath, 'riki')
    .put('self.level' as FieldPath, 9);

  return createContextAssembler({
    matchId: 'test-match' as MatchId,
    world: toContextReader(world.reader()),
    preamble: createPreambleAssembler({ reference: NULL_REFERENCE_DATA }),
  });
}

interface Recorded {
  readonly opened: DebugTurnOpenedInput[];
  readonly closed: { turnId: string; outcome: string }[];
  readonly wrapped: RikiContext;
}

function wrap(delegate: RikiContext): Recorded {
  const opened: DebugTurnOpenedInput[] = [];
  const closed: { turnId: string; outcome: string }[] = [];
  const wrapped = observeContext({
    delegate,
    clock: () => 600,
    onOpened: (turn) => opened.push(turn),
    onClosed: (turnId, outcome) => closed.push({ turnId, outcome }),
  });
  return { opened, closed, wrapped };
}

// -------------------------------------------------------------------------------------------

describe('the wrap is faithful', () => {
  it('carries every member of a real assembler across', () => {
    const delegate = realContext();
    const { wrapped } = wrap(delegate);

    // Not a hand-written list: whatever `createContextAssembler` returns has to survive, so a
    // member added there is covered by this test on the day it is added.
    const missing = Object.keys(delegate).filter((key) => !(key in wrapped));
    expect(missing).toEqual([]);

    // And the members that are not decorated are the delegate's own objects, not copies.
    expect(wrapped.coaching).toBe(delegate.coaching);
    expect(wrapped.ledger).toBe(delegate.ledger);
    expect(wrapped.ledgerRecord).toBe(delegate.ledgerRecord);
    expect(wrapped.working).toBe(delegate.working);
  });

  it('returns the assembler own turn, not a reconstruction of it', () => {
    const delegate = realContext();
    const { wrapped } = wrap(delegate);

    const turn = wrapped.openTurn(
      {
        turnId: 'coach_1' as TurnId,
        cause: { by: 'trigger', event: 'ult_ready' as EventId, salience: 0.8 },
      },
      1_000 as MonoMs,
    );

    expect(turn.turnId).toBe('coach_1');
    expect(turn.snapshot.text.length).toBeGreaterThan(0);
  });

  it('still appends to the ledger, so nothing downstream can tell it was wrapped', () => {
    const delegate = realContext();
    const { wrapped } = wrap(delegate);

    wrapped.openTurn(
      { turnId: 'coach_1' as TurnId, cause: { by: 'player', gesture: 'push_to_talk' } },
      1_000 as MonoMs,
    );
    wrapped.closeTurn('coach_1' as TurnId, 'spoke', 2_000 as MonoMs);

    const kinds = delegate.ledgerRecord.all().map((entry) => entry.kind);
    expect(kinds).toContain('turn_opened');
    expect(kinds).toContain('turn_closed');
  });
});

describe('what it reports', () => {
  it('reports the rendered snapshot and brief for a trigger turn', () => {
    const { opened, wrapped } = wrap(realContext());

    wrapped.openTurn(
      {
        turnId: 'coach_1' as TurnId,
        cause: { by: 'trigger', event: 'ult_ready' as EventId, salience: 0.8 },
      },
      1_000 as MonoMs,
    );

    const [turn] = opened;
    expect(turn?.turnId).toBe('coach_1');
    expect(turn?.cause).toBe('trigger');
    // From the `CoachEvent` that opened the turn, never from a transcript — the same rule the agent
    // holds `agent_said.topics` to.
    expect(turn?.eventId).toBe('ult_ready');
    expect(turn?.salience).toBe(0.8);
    expect(turn?.snapshotText.length).toBeGreaterThan(0);
    expect(turn?.snapshotTokens).toBeGreaterThan(0);
  });

  it('reports no event id for a player turn, which has no topic', () => {
    const { opened, wrapped } = wrap(realContext());

    wrapped.openTurn(
      { turnId: 'turn_1' as TurnId, cause: { by: 'player', gesture: 'push_to_talk' } },
      1_000 as MonoMs,
    );

    expect(opened[0]?.cause).toBe('player');
    expect(opened[0]?.eventId).toBeNull();
    expect(opened[0]?.salience).toBeNull();
  });

  it('reports an empty brief as empty rather than as an absent turn', () => {
    const { opened, wrapped } = wrap(realContext());

    // A `system` cause with almost nothing in the world: the brief has nothing to render. This is
    // the case the inspector exists to make visible — the gates admitted it and it produced no
    // words, which reads as ordinary silence from every other vantage point.
    wrapped.openTurn(
      { turnId: 'coach_2' as TurnId, cause: { by: 'system', reason: 'match_started' } },
      1_000 as MonoMs,
    );

    const [turn] = opened;
    expect(turn).toBeDefined();
    expect(typeof turn?.briefEmpty).toBe('boolean');
    expect(turn?.briefSections).toBeInstanceOf(Array);
  });

  it('reports the close and its outcome', () => {
    const { closed, wrapped } = wrap(realContext());

    wrapped.openTurn(
      {
        turnId: 'coach_1' as TurnId,
        cause: { by: 'trigger', event: 'ult_ready' as EventId, salience: 0.8 },
      },
      1_000 as MonoMs,
    );
    wrapped.closeTurn('coach_1' as TurnId, 'silent', 2_000 as MonoMs);

    expect(closed).toEqual([{ turnId: 'coach_1', outcome: 'silent' }]);
  });
});

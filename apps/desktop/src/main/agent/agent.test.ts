/**
 * The composition root, end to end, with no Electron and no network.
 *
 * A real `ContextAssembler`, a real `EventEngine`, a real world model, and a fake session — which
 * is the whole point of the seams: the only thing in this path that needs a process boundary is the
 * one that speaks, and everything up to it is a pure function of a snapshot.
 *
 * Two blocks carry the file. **`agent_said.topics` comes from the trigger** is the rule that keeps
 * the novelty gate deterministic and ADR-0013's free-text prohibition structural; and **an empty
 * brief is a turn that does not happen** is coaching-architecture.md §6.5, which is easy to
 * implement as "speak anyway with nothing in the message".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BriefRenderer,
  LedgerEntry,
  PreambleAssembler,
  RikiContext,
  TurnId,
} from '@riki/context';
import { createContextAssembler } from '@riki/context';
import { createEventEngine, ultReady } from '@riki/events';
import { buildWorld } from '@riki/events/testing';
import type { VoiceEvent } from '@riki/realtime';
import type { AbilityState, FieldPath, HeroId, MapPosition, MonoMs } from '@riki/world-model';
import { fieldPath, heroField } from '@riki/world-model';
import type { CoachingSessionPort, SessionTurn, SpeakReason } from './contracts.js';
import { createCoachingAgent, resetCoachTurnIds } from './index.js';
import { staticCoachDriver } from './driver.js';
import { toContextReader } from './world-view.js';
import { toEventTapeReader } from './tape.js';

const META_PHASE: FieldPath = fieldPath('meta', 'phase');
const META_CLOCK: FieldPath = fieldPath('meta', 'clock');
const SELF_ALIVE: FieldPath = fieldPath('self', 'alive');
const SELF_HEALTH: FieldPath = fieldPath('self', 'health');
const SELF_MANA: FieldPath = fieldPath('self', 'mana');
const SELF_ABILITIES: FieldPath = fieldPath('self', 'abilities');
const SF = 'sf' as HeroId;
const HERE: MapPosition = { x: 0, y: 0 };

function ult(castable: boolean): AbilityState {
  return { id: 'requiem', level: 3, cooldown: 0, castable, isUltimate: true } as AbilityState;
}

/**
 * A world where `ult_ready` fires and the `cooldowns` and `threat` brief sections have something to
 * render, so the brief is not empty for the wrong reason.
 */
function coachableWorld() {
  return refresh(buildWorld().put(META_PHASE, 'in_progress').put(META_CLOCK, 600));
}

/**
 * Re-observe everything the coachable world is built from.
 *
 * Worth a function rather than an inline `advance`: `self.*` expires at 60 s of game time and a
 * position at 20 s, so a test that only advances the clock is asserting that the sidecar and GSI
 * both went quiet — which renders an empty brief for a completely different reason than the one it
 * means to test.
 */
function refresh(world: ReturnType<typeof buildWorld>) {
  return world
    .put(SELF_ALIVE, true)
    .put(SELF_HEALTH, { current: 800, max: 1000 })
    .put(SELF_MANA, { current: 500, max: 1000 })
    .put(SELF_ABILITIES, [ult(true)])
    .put(heroField('enemies', SF, 'position'), HERE);
}

/** A brief that renders nothing, for the one behaviour that is about what the agent does with it. */
const emptyBriefRenderer: BriefRenderer = {
  render: (_world, req) => ({
    turnId: req.turnId,
    text: '',
    tokens: 0,
    sections: [],
    omitted: [],
    empty: true,
  }),
};

interface FakeSession extends CoachingSessionPort {
  readonly spoke: { turn: SessionTurn; reason: SpeakReason }[];
  readonly ended: { turnId: TurnId; turn: SessionTurn }[];
  readonly aborts: number;
  emit(event: VoiceEvent): void;
}

function fakeSession(): FakeSession {
  const listeners = new Set<(event: VoiceEvent) => void>();
  const spoke: { turn: SessionTurn; reason: SpeakReason }[] = [];
  const ended: { turnId: TurnId; turn: SessionTurn }[] = [];
  let aborts = 0;
  let ids = 0;

  return {
    spoke,
    ended,
    get aborts(): number {
      return aborts;
    },
    speakUnprompted(turn, reason) {
      spoke.push({ turn, reason });
      return Promise.resolve();
    },
    beginTurn() {
      ids += 1;
      return `turn_${String(ids)}` as TurnId;
    },
    endTurn(turnId, _reason, turn) {
      ended.push({ turnId, turn });
      return Promise.resolve();
    },
    abort() {
      aborts += 1;
      return Promise.resolve();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/** `openSession` is never called here, so the preamble only has to exist. */
const stubPreamble: PreambleAssembler = {
  assemble: () => Promise.resolve({ text: '', tokens: 0, sections: [], degraded: [] } as never),
};

function harness(world = coachableWorld(), brief?: BriefRenderer) {
  const reader = world.reader();
  const clock = { now: (): MonoMs => world.now };

  const engine = createEventEngine({
    world: reader,
    clock,
    detectors: [ultReady],
  });

  const context: RikiContext = createContextAssembler({
    matchId: 'test' as never,
    world: toContextReader(reader),
    preamble: stubPreamble,
    tape: toEventTapeReader(engine.tape),
    ...(brief === undefined ? {} : { brief }),
  });

  const session = fakeSession();
  // The deterministic coach behind the port, which is what `shell/index.ts` builds too. Asserting
  // through the adapter rather than around it is the point: the composition root has no path to an
  // `EventEngine` any more, so a test that kept one would be testing a wiring nobody ships.
  const driver = staticCoachDriver(engine);
  const agent = createCoachingAgent({ world: reader, context, driver, session, clock });

  return { world, engine, driver, context, session, agent, clock };
}

function entries(context: RikiContext): readonly LedgerEntry[] {
  return context.ledgerRecord.all();
}

beforeEach(() => {
  resetCoachTurnIds();
});

describe('a coaching turn, end to end', () => {
  it('opens a turn on a trigger and hands the session a snapshot and a brief', async () => {
    const { world, agent, session } = harness();
    agent.start();

    world.commit();
    await Promise.resolve();

    expect(session.spoke).toHaveLength(1);
    expect(session.spoke[0]?.reason.eventId).toBe('ult_ready');
    // One message, two parts. The brief is what this moment is *about*; the snapshot is the view.
    expect(session.spoke[0]?.turn.snapshotText).toContain('\n\n');
  });

  it('records the cause and the brief in the ledger', async () => {
    const { world, agent, context } = harness();
    agent.start();

    world.commit();
    await Promise.resolve();

    const kinds = entries(context).map((entry) => entry.kind);
    expect(kinds).toContain('turn_opened');
    expect(kinds).toContain('snapshot');
    expect(kinds).toContain('brief');

    const opened = entries(context).find((entry) => entry.kind === 'turn_opened');
    expect(opened?.kind === 'turn_opened' && opened.cause).toEqual({
      by: 'trigger',
      event: 'ult_ready',
      salience: expect.any(Number) as number,
    });
  });

  it('tells the engine a turn is open, so a second trigger is dropped rather than queued', async () => {
    const { world, agent, engine, session } = harness();
    agent.start();

    world.commit();
    await Promise.resolve();
    world.commit();
    await Promise.resolve();

    expect(session.spoke).toHaveLength(1);
    expect(engine.counters().suppressed.agent_speaking).toBeGreaterThan(0);
  });
});

describe('an empty brief is a turn that does not happen', () => {
  it('closes the turn silent and never reaches the session', async () => {
    const world = coachableWorld();
    const { agent, context, session } = harness(world, emptyBriefRenderer);
    agent.start();

    world.commit();
    await Promise.resolve();

    expect(session.spoke).toHaveLength(0);
    const closed = entries(context).filter((entry) => entry.kind === 'turn_closed');
    expect(closed.some((entry) => entry.outcome === 'silent')).toBe(true);
  });

  it('appends no brief entry, so "nothing to say" and "said nothing" stay distinguishable', async () => {
    const world = coachableWorld();
    const { agent, context } = harness(world, emptyBriefRenderer);
    agent.start();

    world.commit();
    await Promise.resolve();

    expect(entries(context).some((entry) => entry.kind === 'brief')).toBe(false);
  });
});

describe('topics come from the trigger, never from the text', () => {
  it('attributes the agent transcript to the event that opened the turn', async () => {
    const { world, agent, session, context } = harness();
    agent.start();

    world.commit();
    await Promise.resolve();

    const turnId = session.spoke[0]?.turn.turnId;
    session.emit({
      kind: 'transcript',
      role: 'agent',
      turnId: turnId as never,
      text: 'nice, your ult is up — look for a fight',
      final: true,
    });

    const said = entries(context).find((entry) => entry.kind === 'agent_said');
    expect(said?.kind === 'agent_said' && said.topics).toEqual([
      { of: 'event', event: 'ult_ready' },
    ]);
  });

  it('gives a player-initiated turn no topic at all', () => {
    const { agent, session, context } = harness();
    agent.start();

    const turnId = agent.beginPlayerTurn('push');
    session.emit({
      kind: 'transcript',
      role: 'agent',
      turnId,
      text: 'blade mail is about two thousand gold, but do check',
      final: true,
    });

    const said = entries(context).find((entry) => entry.kind === 'agent_said');
    expect(said?.kind === 'agent_said' && said.topics).toEqual([]);
  });

  it('ignores a non-final transcript', () => {
    const { agent, session, context } = harness();
    agent.start();

    session.emit({
      kind: 'transcript',
      role: 'player',
      turnId: 'turn_1' as never,
      text: 'where is',
      final: false,
    });

    expect(entries(context).some((entry) => entry.kind === 'player_said')).toBe(false);
  });
});

describe('voice intents route into openTurn', () => {
  it('renders a snapshot and a brief for a push-to-talk turn', async () => {
    const { agent, session, context } = harness();
    agent.start();

    const turnId = agent.beginPlayerTurn('push');
    await agent.endPlayerTurn(turnId, 'release');

    expect(session.ended).toHaveLength(1);
    expect(session.ended[0]?.turn.snapshotText).not.toBe('');

    const opened = entries(context).find((entry) => entry.kind === 'turn_opened');
    expect(opened?.kind === 'turn_opened' && opened.cause).toEqual({
      by: 'player',
      gesture: 'push_to_talk',
    });
  });

  it('answers from the snapshot even when the brief renders nothing', async () => {
    const { agent, session } = harness(coachableWorld(), emptyBriefRenderer);
    agent.start();

    const turnId = agent.beginPlayerTurn('push');
    await agent.endPlayerTurn(turnId, 'release');

    expect(session.ended).toHaveLength(1);
    expect(session.ended[0]?.turn.snapshotText).not.toBe('');
  });

  it('cancels without rendering anything', async () => {
    const { agent, context } = harness();
    agent.start();

    const turnId = agent.beginPlayerTurn('push');
    await agent.endPlayerTurn(turnId, 'cancel');

    expect(entries(context).some((entry) => entry.kind === 'snapshot')).toBe(false);
  });

  it('blocks a coaching trigger for the duration of the player’s turn', async () => {
    const { world, agent, engine, session } = harness();
    agent.start();

    agent.beginPlayerTurn('push');
    world.commit();
    await Promise.resolve();

    expect(session.spoke).toHaveLength(0);
    expect(engine.counters().suppressed.agent_speaking).toBeGreaterThan(0);
  });
});

describe('the local commands', () => {
  it('"only when I ask" silences the primary path', async () => {
    const { world, agent, engine, session } = harness();
    agent.start();

    session.emit({ kind: 'command', command: 'quiet-mode', confidence: 0.9 });
    world.commit();
    await Promise.resolve();

    expect(session.spoke).toHaveLength(0);
    expect(engine.counters().suppressed.quiet_mode).toBeGreaterThan(0);
  });

  it('"mute" holds for a while and then lets go', async () => {
    const { world, agent, session } = harness();
    agent.start();

    session.emit({ kind: 'command', command: 'mute', confidence: 0.9 });
    world.commit();
    await Promise.resolve();
    expect(session.spoke).toHaveLength(0);

    refresh(world.advance(11 * 60));
    world.commit();
    await Promise.resolve();
    expect(session.spoke).toHaveLength(1);
  });

  it('"stop" aborts what is being said', async () => {
    const { world, agent, session } = harness();
    agent.start();

    world.commit();
    await Promise.resolve();
    session.emit({ kind: 'command', command: 'stop', confidence: 0.9 });

    expect(session.aborts).toBe(1);
  });
});

describe('the engine’s switches follow the session', () => {
  it('marks the player speaking while they are', async () => {
    const { world, agent, engine, session } = harness();
    agent.start();

    session.emit({ kind: 'speech', event: 'resumed' });
    world.commit();
    await Promise.resolve();

    expect(session.spoke).toHaveLength(0);
    expect(engine.counters().suppressed.player_speaking).toBeGreaterThan(0);
  });

  it('closes the turn when the response ends, and lets the next trigger through', async () => {
    const { world, agent, session } = harness();
    agent.start();

    world.commit();
    await Promise.resolve();
    const turnId = session.spoke[0]?.turn.turnId;
    session.emit({ kind: 'turn', turnId: turnId as never, event: 'responseEnded' });

    // The latch and the kind cooldown still hold, which is the point: closing a turn does not
    // re-open the moment.
    world.commit();
    await Promise.resolve();
    expect(session.spoke).toHaveLength(1);
  });
});

describe('suppression reaches the record', () => {
  it('writes one silent entry per new reason, not one per version bump', async () => {
    const { world, agent, context, session } = harness();
    agent.start();

    session.emit({ kind: 'command', command: 'quiet-mode', confidence: 0.9 });
    for (let i = 0; i < 5; i += 1) {
      world.commit();
      await Promise.resolve();
    }

    const silent = entries(context).filter(
      (entry) => entry.kind === 'turn_closed' && entry.outcome === 'silent',
    );
    expect(silent).toHaveLength(1);
  });

  it('but the counters keep every one of them', async () => {
    const { world, agent, engine, session } = harness();
    agent.start();

    session.emit({ kind: 'command', command: 'quiet-mode', confidence: 0.9 });
    for (let i = 0; i < 5; i += 1) {
      world.commit();
      await Promise.resolve();
    }

    expect(engine.counters().suppressed.quiet_mode).toBe(5);
  });
});

describe('the event tape reaches the snapshot', () => {
  it('carries a detection the gates refused into the recent line', async () => {
    const { world, agent, engine, session } = harness();
    agent.start();

    session.emit({ kind: 'command', command: 'quiet-mode', confidence: 0.9 });
    world.commit();
    await Promise.resolve();

    expect(engine.tape.recent(5, null).map((event) => event.id)).toEqual(['ult_ready']);
  });
});

describe('dispose', () => {
  it('stops both subscriptions', async () => {
    const { world, agent, session } = harness();
    agent.start();
    agent.dispose();

    world.commit();
    await Promise.resolve();

    expect(session.spoke).toHaveLength(0);
  });
});

describe('turn ids', () => {
  it('do not collide with the session’s', async () => {
    const { world, agent, session } = harness();
    agent.start();

    world.commit();
    await Promise.resolve();
    const coachTurn = session.spoke[0]?.turn.turnId;
    const playerTurn = agent.beginPlayerTurn('push');

    expect(coachTurn).toMatch(/^coach_/);
    expect(playerTurn).toMatch(/^turn_/);
    expect(coachTurn).not.toBe(playerTurn);
  });
});

/**
 * The session end to end: capture → stream → transcribe → parse into commands.
 *
 * Everything asserted here is about **what we sent**, because that is where this component's
 * high-risk failures live (§11): a beta-shaped `session.update`, a missing
 * `conversation.item.truncate`, a `response.create` that raced the tail of the utterance, a delete
 * issued before its replacement summary. None of them is observable in a reply.
 *
 * No socket, no browser, no key (REPO_SKELETON.md §5.2, §7.1).
 */

import { describe, expect, it, vi } from 'vitest';
import { createRealtimeSession } from '../src/session.js';
import { createFakeRealtimeTransport, FakeClock } from '../src/testing/index.js';
import { resetTurnIds } from '../src/turn.js';
import type { RealtimeSessionConfig } from '../src/session-config.js';
import type { ClientSecret } from '../src/credentials.js';
import type {
  ItemId,
  MonoMs,
  SessionId,
  TurnId,
  VoiceEvent,
  VoiceTelemetry,
} from '../src/types.js';
import type { ClientEvent } from '../src/wire.js';

const CONFIG: RealtimeSessionConfig = {
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions: '',
  turnDetection: {
    kind: 'server_vad',
    createResponse: false,
    interruptResponse: true,
    silenceDurationMs: 200,
  },
  noiseReduction: 'near_field',
  transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
  truncation: { mode: 'auto', retentionRatio: 0.8 },
};

const SECRET: ClientSecret = {
  value: 'ek_test',
  expiresAt: 60_000 as MonoMs,
  sessionId: 'sess_1' as SessionId,
};

/**
 * Spies kept beside the sink rather than reached for through it.
 *
 * `VoiceTelemetry` declares its members as methods, so `expect(telemetry.fault)` — and even a
 * destructure of it — is an unbound method access. Holding the `vi.fn()`s separately sidesteps
 * that without weakening the rule anywhere it matters.
 */
function telemetrySpies() {
  const spies = {
    turnLatency: vi.fn(),
    truncation: vi.fn(),
    windowDrop: vi.fn(),
    fault: vi.fn(),
    cost: vi.fn(),
    selfInterruption: vi.fn(),
    strayToolCall: vi.fn(),
  };
  const sink: VoiceTelemetry = {
    turnLatency: spies.turnLatency,
    truncation: spies.truncation,
    windowDrop: spies.windowDrop,
    fault: spies.fault,
    cost: spies.cost,
    selfInterruption: spies.selfInterruption,
    strayToolCall: spies.strayToolCall,
  };
  return { spies, sink };
}

async function session(over: { transportKind?: 'webrtc' | 'websocket' } = {}) {
  resetTurnIds();
  const transport = createFakeRealtimeTransport();
  if (over.transportKind) Object.assign(transport, { kind: over.transportKind });

  const clock = new FakeClock(1000);
  const scheduled: (() => void)[] = [];
  const { spies, sink: telemetrySink } = telemetrySpies();

  let audibleMs = 0;
  let captureOpen = false;

  const events: VoiceEvent[] = [];
  const active = await createRealtimeSession(
    {
      transport,
      credentials: { acquire: () => Promise.resolve(SECRET) },
      capture: {
        open: () => {
          captureOpen = true;
        },
        close: () => {
          captureOpen = false;
        },
        get isOpen() {
          return captureOpen;
        },
      },
      playback: { audibleMs: () => audibleMs },
      clock: {
        now: clock.now,
        // Collect rather than fire, so a test decides whether the commit grace expires.
        schedule: (_delayMs, fire) => {
          scheduled.push(fire);
          return () => {
            /* not cancelled in these tests */
          };
        },
      },
      telemetry: telemetrySink,
    },
    { preambleText: 'You are Riki.' },
    CONFIG,
  );

  active.onEvent((event) => events.push(event));

  return {
    transport,
    clock,
    telemetry: spies,
    events,
    session: active,
    isCaptureOpen: () => captureOpen,
    setAudibleMs: (ms: number) => (audibleMs = ms),
    /** Expire the commit grace, which is what `speech_stopped` never arriving looks like. */
    expireGrace: () => {
      for (const fire of scheduled.splice(0)) fire();
    },
    sentOf: <T extends ClientEvent['type']>(type: T) =>
      transport
        .sent()
        .filter((event): event is Extract<ClientEvent, { type: T }> => event.type === type),
  };
}

describe('connect', () => {
  it('configures the session before anything else, and in the GA shape', async () => {
    const { transport } = await session();
    const first = transport.sent()[0];
    expect(first?.type).toBe('session.update');
    // assertGaShape runs on the way out; this asserts it was applied to what we actually sent.
    expect(JSON.stringify(first)).not.toContain('input_audio_format');
  });

  it('sends the preamble as the instructions, not the config default', async () => {
    const { transport } = await session();
    const update = transport.sent()[0] as unknown as { session: { instructions: string } };
    expect(update.session.instructions).toBe('You are Riki.');
  });
});

describe('a push-to-talk turn', () => {
  it('opens capture on beginTurn and closes it on endTurn', async () => {
    const harness = await session();
    const turnId = harness.session.turns.beginTurn('push', harness.clock.now());
    expect(harness.isCaptureOpen()).toBe(true);

    const done = harness.session.turns.endTurn(turnId, 'release', {
      turnId,
      snapshotText: 'gold 2400',
    });
    expect(harness.isCaptureOpen()).toBe(false);
    harness.expireGrace();
    await done;
  });

  it('injects the snapshot before response.create, never after', async () => {
    // "so the model always sees the freshest possible state and always sees it before it is asked
    // to speak" — the reverse order answers from stale state.
    const harness = await session();
    const turnId = harness.session.turns.beginTurn('push', harness.clock.now());
    const done = harness.session.turns.endTurn(turnId, 'release', {
      turnId,
      snapshotText: 'gold 2400',
    });
    harness.expireGrace();
    await done;

    const types = harness.transport.sent().map((event) => event.type);
    expect(types.indexOf('conversation.item.create')).toBeLessThan(
      types.indexOf('response.create'),
    );
  });

  /**
   * The commit race, and the cost of ADR-0017. With VAD on the server commits when it sees speech
   * *stop*, so a `response.create` sent the instant the key is released can outrun the tail of the
   * utterance and answer half a sentence.
   */
  it('waits for speech_stopped before creating the response', async () => {
    const harness = await session();
    const turnId = harness.session.turns.beginTurn('push', harness.clock.now());
    const done = harness.session.turns.endTurn(turnId, 'release', { turnId, snapshotText: '' });

    expect(harness.sentOf('response.create')).toHaveLength(0);

    harness.transport.emit({ type: 'input_audio_buffer.speech_stopped' });
    await done;

    expect(harness.sentOf('response.create')).toHaveLength(1);
  });

  it('proceeds anyway when the grace expires — a late answer beats no answer', async () => {
    const harness = await session();
    const turnId = harness.session.turns.beginTurn('push', harness.clock.now());
    const done = harness.session.turns.endTurn(turnId, 'release', { turnId, snapshotText: '' });

    harness.expireGrace();
    await done;

    expect(harness.sentOf('response.create')).toHaveLength(1);
  });

  it('clears the buffer and creates nothing on cancel', async () => {
    const harness = await session();
    const turnId = harness.session.turns.beginTurn('push', harness.clock.now());
    await harness.session.turns.endTurn(turnId, 'cancel', { turnId, snapshotText: 'x' });

    expect(harness.sentOf('input_audio_buffer.clear')).toHaveLength(1);
    expect(harness.sentOf('response.create')).toHaveLength(0);
  });
});

describe('barge-in and abort — §5.5’s table', () => {
  it('sends no truncate on WebRTC, because the server already did', async () => {
    // Doing both would truncate twice at two different offsets, which leaves the model's belief
    // about what it said wrong in a way that is harder to reason about than not truncating.
    const harness = await session({ transportKind: 'webrtc' });
    harness.transport.emit({ type: 'response.output_item.added', item_id: 'item_1' as ItemId });
    harness.setAudibleMs(750);

    await harness.session.turns.interrupt(harness.clock.now());

    expect(harness.sentOf('conversation.item.truncate')).toHaveLength(0);
  });

  it('sends one on WebSocket, because nothing else will', async () => {
    const harness = await session({ transportKind: 'websocket' });
    harness.transport.emit({ type: 'response.output_item.added', item_id: 'item_1' as ItemId });
    harness.setAudibleMs(750);

    await harness.session.turns.interrupt(harness.clock.now());

    const truncates = harness.sentOf('conversation.item.truncate');
    expect(truncates).toHaveLength(1);
    expect(truncates[0]).toMatchObject({ item_id: 'item_1', audio_end_ms: 750, content_index: 0 });
  });

  /**
   * The row that is easy to miss, and the one that produces the corrupted-model failure: a cancel
   * has no speech behind it, so VAD never fired and no server-side truncation happened.
   */
  it('abort sends BOTH response.cancel and a truncate, on every transport', async () => {
    for (const kind of ['webrtc', 'websocket'] as const) {
      const harness = await session({ transportKind: kind });
      harness.transport.emit({ type: 'response.output_item.added', item_id: 'item_9' as ItemId });
      harness.setAudibleMs(420);

      await harness.session.turns.abort();

      expect(harness.sentOf('response.cancel')).toHaveLength(1);
      expect(harness.sentOf('conversation.item.truncate')).toMatchObject([
        { item_id: 'item_9', audio_end_ms: 420 },
      ]);
    }
  });

  it('truncates nothing when nothing is being spoken', async () => {
    const harness = await session({ transportKind: 'websocket' });
    await harness.session.turns.abort();
    expect(harness.sentOf('conversation.item.truncate')).toHaveLength(0);
  });

  it('reports the truncation to telemetry with the transport that caused it', async () => {
    const harness = await session({ transportKind: 'websocket' });
    harness.transport.emit({ type: 'response.output_item.added', item_id: 'i1' as ItemId });
    harness.setAudibleMs(300);
    await harness.session.turns.abort();
    expect(harness.telemetry.truncation).toHaveBeenCalledWith(300, 'websocket');
  });
});

describe('transcription and local command parsing', () => {
  it('emits the player transcript, then the agent’s', async () => {
    const harness = await session();
    harness.session.turns.beginTurn('push', harness.clock.now());

    harness.transport.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u1' as ItemId,
      transcript: 'should I buy a bkb',
    });
    harness.transport.emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'i1' as ItemId,
      transcript: 'yes, you have the gold',
    });

    expect(
      harness.events
        .filter((event) => event.kind === 'transcript')
        .map((event) => `${event.role}: ${event.text}`),
    ).toEqual(['player: should I buy a bkb', 'agent: yes, you have the gold']);
  });

  it('parses a local command out of the player transcript', async () => {
    const harness = await session();
    harness.session.turns.beginTurn('push', harness.clock.now());
    harness.transport.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u1' as ItemId,
      transcript: 'okay, stop',
    });

    expect(harness.events.filter((event) => event.kind === 'command')).toMatchObject([
      { command: 'stop' },
    ]);
  });

  /**
   * Riki must not be able to mute itself by saying "stop". Parsing agent transcripts would let
   * exactly that happen, and the symptom — Riki going quiet after saying the wrong sentence —
   * would be near-impossible to attribute.
   */
  it('never parses a command out of the agent’s own words', async () => {
    const harness = await session();
    harness.transport.emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'i1' as ItemId,
      transcript: 'stop',
    });
    expect(harness.events.filter((event) => event.kind === 'command')).toEqual([]);
  });
});

describe('a function call from a session that has no tools', () => {
  it('counts it and answers nothing at all', async () => {
    // ADR-0023 deleted command execution, so this event has no correct handling other than a
    // counter. Answering it would create a `function_call_output` for a call the conversation does
    // not contain; dispatching it would need a pipeline that no longer exists.
    const harness = await session();
    harness.transport.emit({
      type: 'response.function_call_arguments.done',
      name: 'get_timings',
    });

    expect(harness.telemetry.strayToolCall).toHaveBeenCalledWith('get_timings');
    expect(harness.sentOf('conversation.item.create')).toEqual([]);
    expect(harness.sentOf('response.create')).toEqual([]);
  });

  it('does not stall the turn, because nothing is waiting on it', async () => {
    // The whole class of machinery §3.1 removed — the watchdog, the one-result invariant, the
    // breaker — existed because an unanswered call stalls a voice conversation. With no dispatch
    // there is nothing to answer and nothing to stall.
    const harness = await session();
    harness.transport.emit({ type: 'response.function_call_arguments.done', name: 'read_screen' });
    harness.transport.emit({
      type: 'response.done',
      response_id: 'resp_1' as never,
      usage: null,
    });

    expect(
      harness.events.filter((event) => event.kind === 'turn' && event.event === 'responseEnded'),
    ).toHaveLength(1);
  });
});

describe('faults and self-interruption', () => {
  it('classifies a beta-schema error as persistent', async () => {
    const harness = await session();
    harness.transport.emit({ type: 'error', code: 'beta-schema', message: 'beta names seen' });
    expect(harness.events.filter((event) => event.kind === 'fault')).toMatchObject([
      { fault: { persistent: true, retryable: false } },
    ]);
  });

  /**
   * `speech_started` while our gate is shut can only be the model hearing itself — the loop
   * research §11.5 documents. It is the signal `turn_detection: null` would have cost us, and is
   * one of ADR-0017's stated benefits.
   */
  it('reports self-interruption when speech starts with the gate closed', async () => {
    const harness = await session();
    harness.transport.emit({ type: 'input_audio_buffer.speech_started' });
    expect(harness.telemetry.selfInterruption).toHaveBeenCalledTimes(1);
  });

  it('does not report it while the player is genuinely talking', async () => {
    const harness = await session();
    harness.session.turns.beginTurn('push', harness.clock.now());
    harness.transport.emit({ type: 'input_audio_buffer.speech_started' });
    expect(harness.telemetry.selfInterruption).not.toHaveBeenCalled();
  });

  it('survives an unknown event', async () => {
    const harness = await session();
    const before = harness.events.length;
    harness.transport.emit({ type: 'unhandled', raw: { type: 'some.future.event' } });
    expect(harness.events).toHaveLength(before);
  });
});

describe('cost and window', () => {
  it('records reported usage and reports it to the window executor', async () => {
    const harness = await session();
    harness.transport.emit({
      type: 'response.done',
      response_id: 'r1' as unknown as never,
      usage: {
        inputAudioTokens: 1400,
        cachedInputTokens: 960,
        outputAudioTokens: 210,
        textTokens: 300,
        at: 1000 as MonoMs,
      },
    });

    expect(harness.session.cost.snapshot().turns).toBe(1);
    expect(harness.session.window.usage()).toEqual({ reportedTokens: 1700, at: 1000 });
  });

  it('window.usage() is null before anything is reported, never an estimate', async () => {
    const harness = await session();
    expect(harness.session.window.usage()).toBeNull();
  });

  it('creates the summary before deleting what it replaces', async () => {
    // The opposite order leaves a window that has forgotten a stretch of the match and does not
    // yet hold its replacement — a gap the model will confidently reason across.
    const harness = await session();
    harness.session.window.bind(1 as never, 'item_old' as ItemId);

    await harness.session.window.apply({
      drop: [1 as never],
      replace: [{ refs: [1 as never], with: { text: 'Earlier: laning went badly.', tokens: 20 } }],
      estimatedTokensAfter: 100,
      reason: 'low_water',
    });

    const types = harness.transport.sent().map((event) => event.type);
    expect(types.indexOf('conversation.item.create')).toBeLessThan(
      types.indexOf('conversation.item.delete'),
    );
  });

  it('reports an unbound ref as dropped, not failed', async () => {
    const harness = await session();
    const applied = await harness.session.window.apply({
      drop: [99 as never],
      replace: [],
      estimatedTokensAfter: 0,
      reason: 'forced',
    });
    expect(applied).toEqual({ dropped: [99], failed: [] });
  });
});

describe('turn ids', () => {
  it('are sequential, so a fixture-driven test reproduces', async () => {
    const harness = await session();
    const first = harness.session.turns.beginTurn('push', harness.clock.now());
    const second = harness.session.turns.beginTurn('push', harness.clock.now());
    expect([first, second]).toEqual(['turn_1' as TurnId, 'turn_2' as TurnId]);
  });
});

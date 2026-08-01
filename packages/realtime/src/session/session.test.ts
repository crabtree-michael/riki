/**
 * The session end to end, against `FakeRealtimeTransport`.
 *
 * Nothing here opens a socket or costs money (REPO_SKELETON.md §5.2, §7.1). The assertions are
 * mostly about *what we sent*, because that is where this API's failures live: every one of the
 * documented traps — the beta schema, the missing truncate, the missing `response.create` —
 * produces a session that runs happily and behaves wrongly.
 */

import { describe, expect, it } from 'vitest';
import { RealtimeSession } from './session.js';
import { FakeClock, FakeRealtimeTransport, serverEvents } from '../testing/index.js';
import type { SessionConfig } from '../types.js';
import type { SessionEvent } from './session.js';
import type { AudioChunkSink } from '@riki/audio';

/**
 * The seam between the two packages, asserted at compile time: `@riki/audio`'s capture stream
 * writes straight into the session. If either side's signature drifts, this stops compiling
 * rather than failing at wiring time in a later task.
 */
const _sinkCompatibility: (session: RealtimeSession) => AudioChunkSink = (session) => session;
void _sinkCompatibility;

const CONFIG: SessionConfig = {
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions: 'You are Riki.',
  tools: [],
  turnDetection: null,
  noiseReduction: 'near_field',
};

async function connected(options: { kind?: 'webrtc' | 'websocket' } = {}) {
  const transport = new FakeRealtimeTransport(options.kind ? { kind: options.kind } : {});
  const clock = new FakeClock(1000);
  const session = new RealtimeSession({ transport, config: CONFIG, now: clock.now });
  const events: SessionEvent[] = [];
  session.on((event) => events.push(event));
  await session.connect();
  transport.emit(serverEvents.sessionCreated());
  return { transport, clock, session, events };
}

describe('connect', () => {
  it('configures the session before anything else is sent', async () => {
    const { transport } = await connected();
    expect(transport.sent[0]?.type).toBe('session.update');
  });

  it('records the session id', async () => {
    const { session } = await connected();
    expect(session.sessionId).toBe('sess_test');
  });
});

describe('a push-to-talk turn', () => {
  /**
   * The failure this guards: with `turn_detection: null` (ADR-0004) nothing but this call ends a
   * turn. Forget `response.create` and the session listens forever and never replies — no error,
   * no timeout, which is the hung-session failure the `voice-realtime` skill opens with.
   */
  it('emits turn:submitted and sends response.create', async () => {
    const { transport, session, events } = await connected();
    session.commitTurn();

    expect(transport.sentOfType('response.create')).toHaveLength(1);
    expect(events).toContainEqual({ kind: 'turn', event: 'submitted' });
  });

  it('commits the input buffer only on the websocket path', async () => {
    const ws = await connected({ kind: 'websocket' });
    ws.session.commitTurn();
    expect(ws.transport.sentOfType('input_audio_buffer.commit')).toHaveLength(1);

    const rtc = await connected({ kind: 'webrtc' });
    rtc.session.commitTurn();
    // On WebRTC the audio rides the media track; committing a buffer we never filled is noise.
    expect(rtc.transport.sentOfType('input_audio_buffer.commit')).toHaveLength(0);
  });

  it('sends audio only on the websocket path, but accounts for it on both', async () => {
    const frame = new Float32Array(2400); // 100 ms at 24 kHz

    const rtc = await connected({ kind: 'webrtc' });
    rtc.session.append(frame);
    expect(rtc.transport.sentOfType('input_audio_buffer.append')).toHaveLength(0);

    const ws = await connected({ kind: 'websocket' });
    ws.session.append(frame);
    expect(ws.transport.sentOfType('input_audio_buffer.append')).toHaveLength(1);
  });

  it('discards an empty turn rather than submitting silence', async () => {
    const { transport, session } = await connected();
    session.discardTurn();
    expect(transport.sentOfType('input_audio_buffer.clear')).toHaveLength(1);
    expect(transport.sentOfType('response.create')).toHaveLength(0);
  });

  it('reports the turn ending', async () => {
    const { transport, events } = await connected();
    transport.emit(serverEvents.responseCreated());
    transport.emit(serverEvents.responseDone());

    expect(events).toContainEqual({ kind: 'turn', event: 'responseStarted' });
    expect(events).toContainEqual({ kind: 'turn', event: 'responseEnded' });
  });
});

describe('barge-in', () => {
  it('sends conversation.item.truncate with what the user actually heard', async () => {
    const { transport, clock, session } = await connected();
    transport.emit(serverEvents.responseCreated());
    transport.emit(serverEvents.audioDelta('item_1', 48_000));
    transport.emit(serverEvents.audioDone('item_1', 4000));

    clock.advance(750);
    session.interrupt(clock.now());

    const truncates = transport.sentOfType('conversation.item.truncate');
    expect(truncates).toHaveLength(1);
    expect(truncates[0]?.item_id).toBe('item_1');
    // 750 ms of wall clock into a 4 s response.
    expect(truncates[0]?.audio_end_ms).toBe(750);
  });

  /**
   * Regression, and the most important assertion in this file.
   *
   * ADR-0002 makes WebRTC the transport, and research §2 says "audio never touches the data
   * channel — it rides the media tracks". So `response.output_audio.delta` **never arrives on the
   * default transport**. An implementation that starts its playback tracker only on audio deltas
   * passes every websocket test, passes review, and then silently never truncates in production —
   * which corrupts every later turn (§4), with no error anywhere.
   */
  it('truncates on WebRTC, where no audio delta ever arrives', async () => {
    const { transport, clock, session } = await connected({ kind: 'webrtc' });
    transport.emit(serverEvents.responseCreated());
    // Transcript only. No audio.delta — exactly what a real WebRTC session looks like.
    transport.emit(serverEvents.assistantTranscriptDelta('item_1', 'you should really'));

    clock.advance(600);
    session.interrupt(clock.now());

    const truncates = transport.sentOfType('conversation.item.truncate');
    expect(truncates).toHaveLength(1);
    expect(truncates[0]?.item_id).toBe('item_1');
    expect(truncates[0]?.audio_end_ms).toBe(600);
  });

  it('cancels the in-flight response as well as truncating', async () => {
    const { transport, session, clock } = await connected();
    transport.emit(serverEvents.responseCreated());
    transport.emit(serverEvents.audioDelta());
    session.interrupt(clock.now());
    expect(transport.sentOfType('response.cancel')).toHaveLength(1);
  });

  it('sends nothing when there is nothing playing', async () => {
    const { transport, session, clock } = await connected();
    session.interrupt(clock.now());
    expect(transport.sentOfType('conversation.item.truncate')).toHaveLength(0);
  });

  it('finalises the transcript at the cut', async () => {
    const { transport, session, clock, events } = await connected();
    transport.emit(serverEvents.responseCreated());
    transport.emit(serverEvents.audioDelta('item_1'));
    transport.emit(serverEvents.assistantTranscriptDelta('item_1', 'you should really'));

    clock.advance(400);
    session.interrupt(clock.now());

    const finals = events.filter(
      (event): event is Extract<SessionEvent, { kind: 'transcript' }> =>
        event.kind === 'transcript' && event.entry.final,
    );
    expect(finals.at(-1)?.entry.text).toBe('you should really');
  });

  it('drops half-assembled tool calls', async () => {
    const { transport, session, clock, events } = await connected();
    transport.emit(serverEvents.responseCreated());
    transport.emit(serverEvents.toolDelta('call_1', 'get_timings', '{"a"'));
    session.interrupt(clock.now());
    transport.emit(serverEvents.toolDone('call_1', ''));

    expect(events.filter((event) => event.kind === 'tool')).toHaveLength(0);
  });

  it('stops being “speaking” after the interrupt', async () => {
    const { transport, session, clock } = await connected();
    transport.emit(serverEvents.responseCreated());
    transport.emit(serverEvents.audioDelta());
    expect(session.speaking).toBe(true);
    session.interrupt(clock.now());
    expect(session.speaking).toBe(false);
  });
});

describe('tool calls', () => {
  it('surfaces a completed call with its arguments unparsed', async () => {
    const { transport, events } = await connected();
    transport.emit(serverEvents.toolDelta('call_1', 'get_enemy_detail', '{"hero"'));
    transport.emit(serverEvents.toolDone('call_1', '{"hero":"sf"}'));

    expect(events).toContainEqual({
      kind: 'tool',
      event: 'started',
      call: { callId: 'call_1', name: 'get_enemy_detail', argumentsJson: '{"hero":"sf"}' },
    });
  });

  it('submits a result and asks the model to continue', async () => {
    const { transport, session } = await connected();
    session.submitToolResult('call_1', '{"roshan":"up"}');

    const items = transport.sentOfType('conversation.item.create');
    expect(items[0]?.item).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    // The tool result is an item, not a turn — without this the model never speaks again.
    expect(transport.sentOfType('response.create')).toHaveLength(1);
  });
});

describe('transcription', () => {
  it('reports both sides of the conversation', async () => {
    const { transport, events } = await connected();
    transport.emit(serverEvents.userTranscriptDone('u1', 'should I buy a bkb'));
    transport.emit(serverEvents.assistantTranscriptDone('i1', 'yes, you have the gold'));

    const finals = events
      .filter(
        (event): event is Extract<SessionEvent, { kind: 'transcript' }> =>
          event.kind === 'transcript' && event.entry.final,
      )
      .map((event) => `${event.entry.role}: ${event.entry.text}`);

    expect(finals).toEqual(['user: should I buy a bkb', 'assistant: yes, you have the gold']);
  });
});

describe('faults', () => {
  it('classifies a beta-schema event as a persistent protocol fault', async () => {
    const { transport, events } = await connected();
    transport.emit(serverEvents.betaAudioDelta());

    const fault = events.find((event) => event.kind === 'fault');
    expect(fault).toMatchObject({ fault: { kind: 'protocol', persistent: true } });
  });

  it('classifies rate limiting as transient', async () => {
    const { transport, events } = await connected();
    transport.emit(serverEvents.error('rate_limit_exceeded', 'slow down'));
    expect(events.find((event) => event.kind === 'fault')).toMatchObject({
      fault: { kind: 'rate-limited', persistent: false },
    });
  });

  it('surfaces a mid-response disconnect', async () => {
    const { transport, events } = await connected();
    transport.emit(serverEvents.responseCreated());
    transport.dropMidResponse();
    expect(events.find((event) => event.kind === 'fault')).toMatchObject({
      fault: { kind: 'session-lost' },
    });
  });

  it('does not die on an unknown event', async () => {
    const { transport, events } = await connected();
    const before = events.length;
    transport.emit({ type: 'some.future.event', payload: 1 });
    expect(events).toHaveLength(before);
  });
});

describe('cost', () => {
  it('accumulates usage and reports the cache hit ratio', async () => {
    const { transport, session } = await connected();
    transport.emit(serverEvents.responseDone('r1', { input: 2000, output: 500, cached: 1500 }));

    const snapshot = session.cost;
    expect(snapshot.cachedInputTokens).toBe(1500);
    expect(snapshot.inputTokens).toBe(500);
    expect(snapshot.cacheHitRatio).toBeCloseTo(0.75, 5);
    // mini: 500 × $10/M + 1500 × $0.125/M + 500 × $20/M
    expect(snapshot.usd).toBeCloseTo((500 * 10 + 1500 * 0.125 + 500 * 20) / 1e6, 9);
  });
});

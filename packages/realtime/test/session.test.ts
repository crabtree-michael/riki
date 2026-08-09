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
import type { ToolDispatcher } from '../src/tools.js';

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
    toolCallRejected: vi.fn(),
  };
  const sink: VoiceTelemetry = {
    turnLatency: spies.turnLatency,
    truncation: spies.truncation,
    windowDrop: spies.windowDrop,
    fault: spies.fault,
    cost: spies.cost,
    selfInterruption: spies.selfInterruption,
    toolCallRejected: spies.toolCallRejected,
  };
  return { spies, sink };
}

async function session(
  over: { transportKind?: 'webrtc' | 'websocket'; tools?: ToolDispatcher } = {},
) {
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
      // Absent unless a test asks for one, because absent is what decides whether the session
      // advertises tools at all — see `RealtimeSessionDeps.tools`.
      ...(over.tools === undefined ? {} : { tools: over.tools }),
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
    /**
     * Let a dispatch settle.
     *
     * A tool call is several awaits deep — the dispatcher, then `encodeToolOutput`'s parse — and a
     * fixed count of microtask ticks gets partway and then asserts about a step that has not
     * happened (`testing` skill, 2026-08-09). A macrotask is the flush that works.
     */
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
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

/**
 * The proactive path — the one the product is actually about, and the one this file never covered.
 *
 * `speakUnprompted` is how every coaching turn reaches the model: no capture, no gesture (dota2
 * §6.4). The composition root allocates the turn id itself (`agent/index.ts`'s `nextCoachTurnId`),
 * hands it over, and then closes the ledger turn off `turn.responseEnded`.
 */
describe('an unprompted coaching turn', () => {
  it('creates a response from the injected snapshot, with no capture', async () => {
    const harness = await session();
    await harness.session.turns.speakUnprompted(
      { turnId: 'coach_1' as TurnId, snapshotText: 'they have no wards' },
      { eventId: 'ward_window', salience: 0.7 },
    );

    expect(harness.isCaptureOpen()).toBe(false);
    const types = harness.transport.sent().map((event) => event.type);
    expect(types.indexOf('conversation.item.create')).toBeLessThan(
      types.indexOf('response.create'),
    );
  });

  /**
   * The seam bug this test exists for.
   *
   * `currentTurn` — the id every `turn.*` event is stamped with — was only ever set by
   * `beginTurn`, so an unprompted turn's `responseStarted`/`responseEnded` carried the *previous*
   * push-to-talk id, or the empty string when there had never been one. `agent/index.ts` closes
   * the ledger turn with `close(voice.turnId, 'spoke', …)` and tags `agent_said.topics` by
   * matching it, so every coaching turn would close a turn that was not open, leave its own open
   * forever, and record its transcript with no topics.
   *
   * Invisible until the real session is wired in: `agent.test.ts` drives a hand-written fake that
   * echoes back the id it was given, which is precisely what the real one did not do.
   */
  it('stamps its own turn id on the events the agent closes the turn with', async () => {
    const harness = await session();

    // A push-to-talk turn first, so a stale `currentTurn` is available to be wrongly reused.
    const spoken = harness.session.turns.beginTurn('push', harness.clock.now());
    const done = harness.session.turns.endTurn(spoken, 'release', {
      turnId: spoken,
      snapshotText: 'gold 2400',
    });
    harness.expireGrace();
    await done;
    harness.transport.emit({ type: 'response.created', response_id: 'resp_1' as never });
    harness.transport.emit({
      type: 'response.done',
      response_id: 'resp_1' as never,
      usage: null,
    });

    await harness.session.turns.speakUnprompted(
      { turnId: 'coach_1' as TurnId, snapshotText: 'they have no wards' },
      { eventId: 'ward_window', salience: 0.7 },
    );
    harness.transport.emit({ type: 'response.created', response_id: 'resp_2' as never });
    harness.transport.emit({
      type: 'response.done',
      response_id: 'resp_2' as never,
      usage: null,
    });

    const coaching = harness.events.filter(
      (event): event is Extract<VoiceEvent, { kind: 'turn' }> =>
        event.kind === 'turn' && event.turnId === 'coach_1',
    );
    expect(coaching.map((event) => event.event)).toEqual([
      'submitted',
      'responseStarted',
      'responseEnded',
    ]);
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

/**
 * The tool round trip (ADR-0042, T4), and the failures that must not become silence.
 *
 * Everything here is asserted on what we *sent*, for this file's usual reason: a
 * `function_call_output` addressed to the wrong id, or one that never goes out, is invisible in a
 * reply — the model simply stops, mid-sentence, having asked a question nobody answered.
 */
describe('a tool call', () => {
  /** A dispatcher written by hand, so no world model is anywhere near this file. */
  function dispatcherReturning(result: unknown): {
    dispatcher: ToolDispatcher;
    calls: { name: string; args: unknown }[];
  } {
    const calls: { name: string; args: unknown }[] = [];
    return {
      calls,
      dispatcher: {
        call: (name, args) => {
          calls.push({ name, args });
          return Promise.resolve(result as never);
        },
      },
    };
  }

  const enemyCall = (over: Partial<{ name: string; args: string; callId: string }> = {}) =>
    ({
      type: 'response.function_call_arguments.done' as const,
      call_id: (over.callId ?? 'call_1') as never,
      name: over.name ?? 'enemy',
      arguments: over.args ?? '{"hero":"puck"}',
    }) satisfies Parameters<ReturnType<typeof createFakeRealtimeTransport>['emit']>[0];

  /** The `function_call_output` items we sent, unwrapped from their conversation items. */
  const outputs = (harness: Awaited<ReturnType<typeof session>>) =>
    harness
      .sentOf('conversation.item.create')
      .map((event) => event.item as { type: string; call_id: string; output: string })
      .filter((item) => item.type === 'function_call_output');

  it('advertises the five tools, and a tool_choice, once a dispatcher is injected', async () => {
    const { dispatcher } = dispatcherReturning({ enemies: [] });
    const harness = await session({ tools: dispatcher });
    const update = harness.transport.sent()[0] as unknown as {
      session: { tools: { name: string }[]; tool_choice: string };
    };

    expect(update.session.tools.map((tool) => tool.name).sort()).toEqual([
      'economy',
      'enemy',
      'my_state',
      'objectives',
      'world_at',
    ]);
    expect(update.session.tool_choice).toBe('auto');
  });

  it('dispatches it and answers with the tool’s own JSON, then lets the model carry on', async () => {
    const { dispatcher, calls } = dispatcherReturning({ enemies: [] });
    const harness = await session({ tools: dispatcher });
    harness.transport.emit(enemyCall());
    await harness.flush();

    expect(calls).toEqual([{ name: 'enemy', args: { hero: 'puck' } }]);
    expect(outputs(harness)).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: '{"enemies":[]}' },
    ]);

    // Order is the assertion: an output that arrives after the `response.create` it belongs to is
    // an answer the model was not looking at when it resumed speaking.
    const types = harness.transport.sent().map((event) => event.type);
    expect(types.lastIndexOf('conversation.item.create')).toBeLessThan(
      types.lastIndexOf('response.create'),
    );
  });

  /**
   * The ticket's second half, and the one that decides whether a bad afternoon is a wrong answer
   * or a dead session: *a tool that throws produces a degraded answer rather than a dead turn.*
   */
  it('turns a thrown dispatcher into an `unknown`, and still continues the response', async () => {
    const harness = await session({
      tools: {
        call: () => Promise.reject(new Error('the world model is not running')),
      },
    });
    harness.transport.emit(enemyCall());
    await harness.flush();

    expect(outputs(harness)).toHaveLength(1);
    expect(JSON.parse(outputs(harness)[0]?.output ?? '{}')).toEqual({
      unknown: expect.stringContaining('the world model is not running') as unknown,
    });
    expect(harness.sentOf('response.create')).toHaveLength(1);
  });

  /**
   * The other side of `encodeToolOutput`'s refusal. A tool that answered a never-observed field
   * with a zero is the failure the whole `Fact` envelope exists to prevent (ADR-0043) — it must
   * not reach the model, and it must not take the turn down with it either.
   */
  it('degrades a result the tool’s own schema refuses', async () => {
    const { dispatcher } = dispatcherReturning({ enemies: [{ hero: '' }] });
    const harness = await session({ tools: dispatcher });
    harness.transport.emit(enemyCall());
    await harness.flush();

    expect(JSON.parse(outputs(harness)[0]?.output ?? '{}')).toHaveProperty('unknown');
    expect(harness.sentOf('response.create')).toHaveLength(1);
  });

  it('refuses a tool that does not exist without dispatching, and says so to the model', async () => {
    const { dispatcher, calls } = dispatcherReturning({ enemies: [] });
    const harness = await session({ tools: dispatcher });
    harness.transport.emit(enemyCall({ name: 'read_screen' }));
    await harness.flush();

    expect(calls).toEqual([]);
    expect(harness.telemetry.toolCallRejected).toHaveBeenCalledWith('read_screen', 'unknown-tool');
    // Answered anyway: the detail names the five tools, so the refusal is also the correction.
    expect(JSON.parse(outputs(harness)[0]?.output ?? '{}')).toEqual({
      unknown: expect.stringContaining('read_screen') as unknown,
    });
    expect(harness.sentOf('response.create')).toHaveLength(1);
  });

  it('refuses arguments the schema rejects without dispatching', async () => {
    const { dispatcher, calls } = dispatcherReturning({ enemies: [] });
    const harness = await session({ tools: dispatcher });
    harness.transport.emit(enemyCall({ args: '{"heroes":["puck"]}' }));
    await harness.flush();

    expect(calls).toEqual([]);
    expect(harness.telemetry.toolCallRejected).toHaveBeenCalledWith('enemy', 'invalid-arguments');
    expect(outputs(harness)).toHaveLength(1);
  });

  /**
   * A call with no id has nowhere for the answer to land, and the API refuses an output item
   * addressed to nothing — mid-turn, out loud. The empty `sessionId` that failed four layers away
   * as silence is the same shape (voice-realtime skill, 2026-08-04); this one is caught here.
   */
  it('does not answer a call it has no id to answer', async () => {
    const { dispatcher, calls } = dispatcherReturning({ enemies: [] });
    const harness = await session({ tools: dispatcher });
    harness.transport.emit(enemyCall({ callId: '' }));
    await harness.flush();

    expect(calls).toEqual([]);
    expect(harness.telemetry.toolCallRejected).toHaveBeenCalledWith('enemy', 'no-call-id');
    expect(outputs(harness)).toEqual([]);
    expect(harness.sentOf('response.create')).toEqual([]);
  });

  /**
   * The tool layer is not wired in production yet — the dispatcher would have to cross the preload
   * bridge — so this is the live path, and it is the one ADR-0023 described: nothing advertised,
   * so a call can only be the model inventing one (realtime §11.6).
   */
  it('with no dispatcher, advertises nothing and answers nothing', async () => {
    const harness = await session();
    const update = harness.transport.sent()[0] as unknown as { session: Record<string, unknown> };
    expect(update.session.tools).toEqual([]);
    expect(update.session).not.toHaveProperty('tool_choice');

    harness.transport.emit(enemyCall({ name: 'get_timings' }));
    await harness.flush();

    expect(harness.telemetry.toolCallRejected).toHaveBeenCalledWith('get_timings', 'no-tools');
    expect(harness.sentOf('conversation.item.create')).toEqual([]);
    expect(harness.sentOf('response.create')).toEqual([]);
  });

  it('does not stall the turn when it answers nothing', async () => {
    // The machinery ADR-0042 removed — the watchdog, the one-result invariant, the breaker —
    // existed because an unanswered call stalls a voice conversation. Nothing here waits on one.
    const harness = await session();
    harness.transport.emit(enemyCall({ name: 'read_screen' }));
    harness.transport.emit({ type: 'response.done', response_id: 'resp_1' as never, usage: null });
    await harness.flush();

    expect(
      harness.events.filter((event) => event.kind === 'turn' && event.event === 'responseEnded'),
    ).toHaveLength(1);
  });

  /**
   * A tool call puts an `await` in the middle of a spoken response, which is the one place where
   * "the player pressed Esc" and "we are about to ask for more speech" are both true. The output
   * still goes out — a conversation must not carry a call with no answer — and the continuation
   * does not, because resuming forty milliseconds after being told to stop is precisely the
   * interruption ADR-0042 removed by construction.
   */
  it('answers a call the player cancelled, but does not resume speaking', async () => {
    let release = (result: unknown): void => void result;
    const harness = await session({
      tools: { call: () => new Promise((resolve) => (release = resolve)) as never },
    });

    harness.transport.emit(enemyCall());
    await harness.session.turns.abort();
    release({ enemies: [] });
    await harness.flush();

    expect(outputs(harness)).toHaveLength(1);
    expect(harness.sentOf('response.cancel')).toHaveLength(1);
    expect(harness.sentOf('response.create')).toEqual([]);
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

/**
 * The 60-minute cap — ADR-0045.
 *
 * Observed live on 2026-08-09 at 15:43:36: `session_expired`, then the data channel closed, then
 * ICE disconnected, and nothing reconnected for the rest of the match. Renewal itself is main's
 * (`apps/desktop/src/main/voice/session.ts` — it needs the `ApiKey` to mint, and that is in the
 * other process); what this package owes is **detection**, and the property that makes renewal
 * possible at all is that the expiry is classified as retryable rather than fatal.
 */
describe('the session expiring', () => {
  const faultsOf = (harness: Awaited<ReturnType<typeof session>>) =>
    harness.events.filter((event) => event.kind === 'fault');

  it('classifies session_expired as a retryable session-lost, not as auth and not as offline', async () => {
    // The row this asserts is ordering in `faultFor`: the expiry test runs before the auth test.
    // As `auth` it would be persistent and non-retryable, which is exactly the shape that stops
    // main renewing and puts a permanent error on a chip that has nothing wrong with it.
    const harness = await session();
    harness.transport.emit({
      type: 'error',
      code: 'session_expired',
      message: 'Your session hit the maximum duration of 60 minutes.',
    });

    expect(faultsOf(harness)).toMatchObject([
      {
        fault: {
          kind: 'session-lost',
          persistent: false,
          retryable: true,
          message: 'Your session hit the maximum duration of 60 minutes.',
        },
      },
    ]);
  });

  it('reports a transport that closed under it, which is the half with no event behind it', async () => {
    // On WebRTC the channel can go before the error does, in which case `session_expired` never
    // arrives and a transport that stopped is the only evidence. Before this, `onStateChange` had
    // no subscriber here at all and a dead peer connection was completely silent.
    const harness = await session();
    harness.transport.dropConnection('idle');

    expect(faultsOf(harness)).toMatchObject([{ fault: { kind: 'session-lost', retryable: true } }]);
  });

  it.each(['error-first', 'close-first'] as const)(
    'reports one fault for one loss, %s',
    async (order) => {
      // Both signals fire for a single expiry. Two faults would have main renew, finish, and
      // immediately renew again — a second reopen for a session that was never lost.
      const harness = await session();
      harness.transport.expireSession(order);

      expect(faultsOf(harness)).toHaveLength(1);
      expect(harness.telemetry.fault).toHaveBeenCalledTimes(1);
    },
  );

  it('says nothing when we are the ones closing', async () => {
    // Every renewal tears the old session down on purpose. If an orderly close raised the fault
    // that triggers a renewal, renewal would be a loop rather than a repair.
    const harness = await session();
    await harness.session.close('match ended');

    expect(faultsOf(harness)).toEqual([]);
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

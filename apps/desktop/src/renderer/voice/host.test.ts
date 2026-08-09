/**
 * Tier 1 for the voice window's composition root — the file `host.ts` has always claimed exists.
 *
 * It is scoped to the tool layer (T12), because that is what this commit added and because that is
 * the wiring whose absence was invisible everywhere else: the dispatcher is built here, the
 * decision to advertise anything is read off a directive here, and a tool result is routed *past*
 * the directive queue here. None of those is reachable from `tools.test.ts` next door, which knows
 * only about the dispatcher, and none is reachable from the seam test in `apps/desktop/test/`,
 * which stands in for this file rather than driving it.
 *
 * Everything DOM-shaped arrives through `VoiceMediaPorts` and `VoiceBridgePort`, which is the
 * property the file was written for — so this runs in a bare Vitest process with no microphone, no
 * `AudioContext` and no peer connection, and the data channel is a function the test calls.
 */

import { describe, expect, it } from 'vitest';

import type { AudioGraphBackend, RemoteAnalyser } from '@riki/audio';
import { createFakeAudioDevice } from '@riki/audio/testing';
import type { DeviceRegistry } from '@riki/audio';
import type { VoiceDirective, VoiceUpdate } from '@riki/protocol';
import { PROTOCOL_VERSION, voice } from '@riki/protocol';
import type { DataChannelLike, PeerConnectionLike, Unsubscribe } from '@riki/realtime';

import type { VoiceBridgePort } from './contracts.js';
import { createVoiceHost } from './host.js';

const SESSION = {
  model: 'gpt-realtime-2.1-mini' as const,
  voice: 'marin' as const,
  instructions: 'You are Riki.',
  turnDetection: {
    kind: 'server_vad' as const,
    createResponse: false as const,
    interruptResponse: true,
    silenceDurationMs: 200,
  },
  noiseReduction: 'near_field' as const,
  transcription: null,
  truncation: { mode: 'auto' as const, retentionRatio: 0.8 },
};

/** The peer connection, as `transport.ts` uses it. The data channel is the test's hand-crank. */
function fakePeer() {
  let onMessage: ((payload: string) => void) | null = null;
  let onOpen: (() => void) | null = null;
  const sent: string[] = [];

  const channel: DataChannelLike = {
    send: (payload) => sent.push(payload),
    onMessage: (listener): Unsubscribe => {
      onMessage = listener;
      return () => (onMessage = null);
    },
    onOpen: (listener): Unsubscribe => {
      onOpen = () => {
        onOpen = null;
        listener();
      };
      return () => (onOpen = null);
    },
    close: () => undefined,
  };

  const connection: PeerConnectionLike = {
    createDataChannel: () => channel,
    createOffer: () => Promise.resolve({ sdp: 'v=0 offer' }),
    setLocalDescription: () => Promise.resolve(),
    setRemoteDescription: () => Promise.resolve(),
    addTrack: () => undefined,
    onTrack: (): Unsubscribe => () => undefined,
    onConnectionStateChange: (): Unsubscribe => () => undefined,
    close: () => undefined,
  };

  return {
    connection,
    sent,
    /** The DTLS/SCTP handshake finishing, which is what makes the transport `open`. */
    openChannel: (): void => onOpen?.(),
    /** One server event arriving on the data channel. */
    deliver: (event: unknown): void => onMessage?.(JSON.stringify(event)),
    /** What the session sent the model, parsed. */
    parsed: (): Record<string, unknown>[] =>
      sent.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function harness() {
  const device = createFakeAudioDevice();
  const peer = fakePeer();
  const updates: VoiceUpdate[] = [];
  let deliver: ((raw: unknown) => void) | null = null;
  let now = 1_000;

  const bridge: VoiceBridgePort = {
    onDirective(listener) {
      deliver = listener;
      return () => (deliver = null);
    },
    send: (update) => updates.push(update as VoiceUpdate),
  };

  const devices: DeviceRegistry = {
    list: () => Promise.resolve([]),
    permission: () => Promise.resolve('granted'),
    open: () => Promise.resolve(device.stream),
    close: () => undefined,
    onChange: (): Unsubscribe => () => undefined,
    onFault: (): Unsubscribe => () => undefined,
  };

  const host = createVoiceHost({
    bridge,
    devices,
    media: {
      createBackend: (): Promise<AudioGraphBackend> => Promise.resolve(device.backend),
      createPeerConnection: () => peer.connection,
      analyserFor: (): RemoteAnalyser => ({
        onFrame: (): Unsubscribe => () => undefined,
        dispose: () => undefined,
      }),
      play: () => undefined,
      dispose: () => Promise.resolve(),
    },
    clock: {
      now: () => now as never,
      // Deadlines are `tools.test.ts`'s subject; here a live one would only add a race.
      schedule: () => () => undefined,
    },
    fetch: () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('v=0 answer') }),
  });

  const stop = host.start();

  return {
    host,
    peer,
    updates,
    stop,
    advance: (ms: number): void => {
      now += ms;
    },
    send(directive: VoiceDirective): void {
      deliver?.(directive);
    },
    /** Open a session and get the data channel to `open`, which is when the config goes out. */
    async open(tools: boolean): Promise<void> {
      this.send(
        voice.sessionOpen({
          secret: { value: 'ek_test_secret', expiresInMs: 60_000, sessionId: 'sess_1' },
          session: SESSION,
          capture: {
            deviceId: null,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            preRollMs: 0,
          },
          transport: 'webrtc',
          budgetUsd: 2.5,
          tools,
        }),
      );
      await settle();
      peer.openChannel();
      await settle();
    },
    /** The `session.update` the session actually sent, which is where the manifest lives. */
    manifest(): readonly { readonly name: string }[] {
      const update = peer.parsed().find((event) => event.type === 'session.update') as
        { session?: { tools?: readonly { name: string }[] } } | undefined;
      return update?.session?.tools ?? [];
    },
    toolCalls(): Extract<VoiceUpdate, { type: 'voice.tool.call' }>[] {
      return updates.filter((update) => update.type === 'voice.tool.call');
    },
    outputs(): { readonly call_id?: string; readonly output?: string }[] {
      return peer.parsed().flatMap((event) => {
        const item = (event as { item?: { type?: string; call_id?: string; output?: string } })
          .item;
        return item?.type === 'function_call_output' ? [item] : [];
      });
    },
  };
}

async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('whether the session is given a tool layer at all', () => {
  it('advertises the five tools when main says it can answer them', async () => {
    const h = harness();
    await h.open(true);

    expect(
      h
        .manifest()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['economy', 'enemy', 'my_state', 'objectives', 'world_at']);
    h.stop();
  });

  it('advertises none when main says it cannot', async () => {
    // ADR-0049. The renderer builds the dispatcher and main owns the thing that answers, so this
    // boolean is the only way the coupling can hold across the boundary. Getting it wrong in this
    // direction is the failure the ADR calls "strictly worse than not offering them".
    const h = harness();
    await h.open(false);

    expect(h.manifest()).toEqual([]);
    h.stop();
  });
});

describe('a tool call the model makes', () => {
  it('goes out on the bridge and is answered back into the same response', async () => {
    const h = harness();
    await h.open(true);

    h.peer.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'enemy',
      arguments: JSON.stringify({ hero: 'pudge' }),
    });
    await settle();

    const call = h.toolCalls()[0];
    expect(call).toMatchObject({ name: 'enemy', args: { hero: 'pudge' } });

    // Main's answer, arriving as a directive — and **not** through the queue. See `settleToolCall`.
    h.send(voice.toolResult(call?.callId ?? '', { enemies: [] }));
    await settle();

    const output = h.outputs().find((item) => item.call_id === 'call_1');
    expect(output).toBeDefined();
    expect(JSON.parse(output?.output ?? '{}')).toEqual({ enemies: [] });
    h.stop();
  });

  it('is answered even while a directive handler is still awaiting', async () => {
    // The deadlock `settleToolCall` exists to rule out, in the shape it actually takes.
    //
    // `voice.turn.end` is the directive that waits: `TurnController.endTurn` blocks on
    // `speech_stopped`, bounded by the commit grace — and both the event and the timer come from
    // outside this file. Queue a tool result behind that handler and the result is a response
    // that never continues, from a call main answered instantly, with no error on either side.
    // This is *the* failure mode of the whole ticket, so the test drives the real chain rather
    // than asserting the interception exists.
    const h = harness();
    await h.open(true);

    h.peer.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'call_2',
      name: 'my_state',
      arguments: '{}',
    });
    await settle();
    const call = h.toolCalls()[0];
    expect(call).toBeDefined();

    // Neither `speech_stopped` nor the grace timer will arrive, so this handler never resolves.
    h.send(voice.turnBegin('turn_1', 'push'));
    await settle();
    h.send(voice.turnEnd('turn_1', 'release', 'the world, as text'));

    h.send(voice.toolResult(call?.callId ?? '', { hero: { unknown: 'nobody looked' } }));
    await settle();

    // The turn has not submitted — which is the whole point: the queue is genuinely blocked, and
    // the snapshot `endTurn` injects just before it asks for a response has not gone out.
    // (`response.create` is no good as the marker here: `submitToolOutput` sends one of its own,
    // which is the continuation that makes the answer audible.)
    expect(h.peer.sent.some((line) => line.includes('the world, as text'))).toBe(false);
    expect(h.outputs().find((item) => item.call_id === 'call_2')).toBeDefined();
    h.stop();
  });

  it('does not leave a closed session behind when a call was in flight', async () => {
    // `closeSession` abandons the pending calls before tearing anything down. What that buys is
    // not an answer — the transport is going away and nothing will hear it — but the *absence* of
    // a promise and a deadline that outlive their session. A leak here is invisible for a match
    // and then shows up as a `callId` from a dead session settling a live one's call, which is a
    // confident answer to a question nobody asked.
    const h = harness();
    await h.open(true);

    h.peer.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'call_3',
      name: 'my_state',
      arguments: '{}',
    });
    await settle();
    const abandoned = h.toolCalls()[0];
    expect(abandoned).toBeDefined();

    h.send(voice.sessionClose('match ended'));
    await settle();

    // The next match. A call here must be answerable, and the previous session's `callId` must not
    // settle it — `callId`s restart with the session, so a leak would make these two collide.
    await h.open(true);
    h.peer.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'call_4',
      name: 'my_state',
      arguments: '{}',
    });
    await settle();

    const fresh = h.toolCalls().at(-1);
    expect(fresh?.callId).toBe(abandoned?.callId);
    h.send(voice.toolResult(fresh?.callId ?? '', { hero: { unknown: 'nobody looked' } }));
    await settle();

    expect(h.outputs().find((item) => item.call_id === 'call_4')).toBeDefined();
    // And the abandoned call never produced one, because its session had gone.
    expect(h.outputs().find((item) => item.call_id === 'call_3')).toBeUndefined();
    h.stop();
  });
});

describe('a call the model gets wrong', () => {
  it('is reported to main rather than dying in this renderer', async () => {
    // `parseToolCall` refuses a name outside the five before anything is dispatched, which is the
    // one failure main's dispatch decorator structurally cannot see (ADR-0047). Without this
    // message it is a number in a renderer with no console, and "the model is calling a tool that
    // does not exist" is indistinguishable from "the model chose not to call anything".
    const h = harness();
    await h.open(true);

    h.peer.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'call_4',
      name: 'map_state',
      arguments: '{}',
    });
    await settle();

    expect(h.updates.filter((update) => update.type === 'voice.tool.rejected')).toMatchObject([
      { name: 'map_state', reason: 'unknown-tool' },
    ]);
    expect(h.toolCalls()).toHaveLength(0);
    h.stop();
  });

  it('carries the protocol version on every message it sends', () => {
    const h = harness();
    expect(h.updates.every((update) => update.v === PROTOCOL_VERSION)).toBe(true);
    h.stop();
  });
});

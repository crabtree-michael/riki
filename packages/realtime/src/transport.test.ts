/**
 * The transports, with the browser primitives injected.
 *
 * The negotiation sequence is the part worth pinning: it is order-dependent in a way nothing
 * checks at runtime, and every way of getting it wrong fails as a session that connects and then
 * carries no events.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createWebRtcTransport,
  createWebSocketTransport,
  OAI_EVENT_CHANNEL,
  REALTIME_CALLS_URL,
  type DataChannelLike,
  type PeerConnectionLike,
  type SocketLike,
} from './transport.js';
import type { ClientSecret } from './credentials.js';
import type { MonoMs, SessionId, Unsubscribe } from './types.js';
import type { ServerEvent } from './wire.js';

/** An empty PCM stream. A hand-rolled iterator rather than a generator, which lint reads as
 * async-without-await when it yields nothing. */
const EMPTY_PCM = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true as const, value: undefined }),
  }),
} as unknown as AsyncIterable<Int16Array>;

const SECRET: ClientSecret = {
  value: 'ek_test_secret',
  expiresAt: 60_000 as MonoMs,
  sessionId: 's1' as SessionId,
};

function peer() {
  const order: string[] = [];
  let channelMessage: ((payload: string) => void) | null = null;
  const channelSends: string[] = [];
  let channelName = '';

  const channel: DataChannelLike = {
    send: (payload) => channelSends.push(payload),
    onMessage: (listener): Unsubscribe => {
      channelMessage = listener;
      return () => {
        channelMessage = null;
      };
    },
    onOpen: (): Unsubscribe => () => undefined,
    close: () => order.push('channel.close'),
  };

  const connection: PeerConnectionLike = {
    createDataChannel: (label) => {
      channelName = label;
      order.push('createDataChannel');
      return channel;
    },
    createOffer: () => {
      order.push('createOffer');
      return Promise.resolve({ sdp: 'v=0 offer' });
    },
    setLocalDescription: () => {
      order.push('setLocalDescription');
      return Promise.resolve();
    },
    setRemoteDescription: () => {
      order.push('setRemoteDescription');
      return Promise.resolve();
    },
    addTrack: () => order.push('addTrack'),
    onTrack: (): Unsubscribe => () => undefined,
    onConnectionStateChange: (): Unsubscribe => () => undefined,
    close: () => order.push('peer.close'),
  };

  return {
    connection,
    order,
    channelSends,
    channelName: () => channelName,
    deliver: (payload: string) => channelMessage?.(payload),
  };
}

function harness(response = { ok: true, status: 200, body: 'v=0 answer' }) {
  const p = peer();
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const transport = createWebRtcTransport({
    createPeerConnection: () => p.connection,
    fetch: (url, init) => {
      requests.push({ url, headers: { ...init.headers }, body: init.body });
      return Promise.resolve({
        ok: response.ok,
        status: response.status,
        text: () => Promise.resolve(response.body),
      });
    },
    now: () => 1000 as MonoMs,
  });
  return { ...p, requests, transport };
}

const MEDIA = {
  kind: 'track' as const,
  outbound: { id: 'out' },
  onRemoteTrack: () => undefined,
};

describe('WebRTC negotiation', () => {
  /**
   * The data channel must be created *before* the offer, or it is not in the SDP and the server
   * has nothing to answer with — a session that connects and then carries no events at all.
   */
  it('creates the data channel before the offer', async () => {
    const { transport, order } = harness();
    await transport.connect(SECRET, MEDIA);
    expect(order.indexOf('createDataChannel')).toBeLessThan(order.indexOf('createOffer'));
  });

  it('names the channel oai-events, which is fixed by the API', async () => {
    const { transport, channelName } = harness();
    await transport.connect(SECRET, MEDIA);
    expect(channelName()).toBe(OAI_EVENT_CHANNEL);
    expect(OAI_EVENT_CHANNEL).toBe('oai-events');
  });

  it('runs the full sequence in order', async () => {
    const { transport, order } = harness();
    await transport.connect(SECRET, MEDIA);
    expect(order).toEqual([
      'addTrack',
      'createDataChannel',
      'createOffer',
      'setLocalDescription',
      'setRemoteDescription',
    ]);
  });

  it('POSTs the offer SDP as application/sdp, authorised with the ephemeral secret', async () => {
    const { transport, requests } = harness();
    await transport.connect(SECRET, MEDIA);

    expect(requests[0]?.url).toBe(REALTIME_CALLS_URL);
    expect(requests[0]?.headers['Content-Type']).toBe('application/sdp');
    expect(requests[0]?.body).toBe('v=0 offer');
    // ADR-0015: this runs in a renderer, so it must be the ephemeral secret and never the key.
    expect(requests[0]?.headers.Authorization).toBe('Bearer ek_test_secret');
    expect(requests[0]?.headers.Authorization).not.toContain('sk-');
  });

  it('fails loudly when the call endpoint rejects', async () => {
    const { transport } = harness({ ok: false, status: 401, body: '' });
    await expect(transport.connect(SECRET, MEDIA)).rejects.toThrow(/HTTP 401/);
  });

  it('refuses PCM media — the two transports do not abstract over it', async () => {
    // "pretending otherwise would put a fake abstraction exactly where the real difference is."
    const { transport } = harness();
    await expect(
      transport.connect(SECRET, {
        kind: 'pcm',
        outbound: EMPTY_PCM,
        onOutputAudio: () => undefined,
      }),
    ).rejects.toThrow(/media track/);
  });
});

describe('WebRTC event flow', () => {
  it('parses inbound frames into ServerEvents', async () => {
    const { transport, deliver } = harness();
    const seen: ServerEvent[] = [];
    transport.onEvent((event) => seen.push(event));
    await transport.connect(SECRET, MEDIA);

    deliver(JSON.stringify({ type: 'response.created', response_id: 'r1' }));
    expect(seen).toContainEqual({ type: 'response.created', response_id: 'r1' });
  });

  it('does not die on an unparseable frame', async () => {
    // A malformed frame is not a reason to drop the session.
    const { transport, deliver } = harness();
    const seen: ServerEvent[] = [];
    transport.onEvent((event) => seen.push(event));
    await transport.connect(SECRET, MEDIA);

    expect(() => deliver('{not json')).not.toThrow();
    expect(seen.at(-1)?.type).toBe('unhandled');
  });

  it('serialises outgoing events onto the channel', async () => {
    const { transport, channelSends } = harness();
    await transport.connect(SECRET, MEDIA);
    transport.send({ type: 'response.cancel' });
    expect(channelSends).toEqual([JSON.stringify({ type: 'response.cancel' })]);
  });

  it('reports state transitions', async () => {
    const { transport } = harness();
    const states: string[] = [];
    transport.onStateChange((state) => states.push(state));
    await transport.connect(SECRET, MEDIA);
    await transport.close('done');
    expect(states).toEqual(['connecting', 'open', 'closing', 'closed']);
  });

  it('closes the channel and the peer connection', async () => {
    const { transport, order } = harness();
    await transport.connect(SECRET, MEDIA);
    await transport.close('done');
    expect(order).toContain('channel.close');
    expect(order).toContain('peer.close');
  });
});

describe('WebSocket transport', () => {
  function socketHarness() {
    let onOpen: (() => void) | null = null;
    let onMessage: ((payload: string) => void) | null = null;
    const sends: string[] = [];

    const socket: SocketLike = {
      send: (payload) => sends.push(payload),
      onMessage: (listener): Unsubscribe => {
        onMessage = listener;
        return () => undefined;
      },
      onOpen: (listener): Unsubscribe => {
        onOpen = listener;
        return () => undefined;
      },
      onClose: (): Unsubscribe => () => undefined,
      close: vi.fn(),
    };

    const protocols: string[][] = [];
    const transport = createWebSocketTransport({
      connect: (_url, requested) => {
        protocols.push([...requested]);
        return socket;
      },
      now: () => 1000 as MonoMs,
    });

    return {
      transport,
      sends,
      protocols,
      open: () => onOpen?.(),
      deliver: (payload: string) => onMessage?.(payload),
    };
  }

  const PCM_MEDIA = {
    kind: 'pcm' as const,
    outbound: EMPTY_PCM,
    onOutputAudio: () => undefined,
  };

  it('resolves only once the socket is open', async () => {
    const { transport, open } = socketHarness();
    let resolved = false;
    const connecting = transport.connect(SECRET, PCM_MEDIA).then(() => (resolved = true));

    expect(resolved).toBe(false);
    open();
    await connecting;
    expect(resolved).toBe(true);
  });

  it('carries the secret in the subprotocol, which is how this endpoint authorises', async () => {
    const { transport, protocols, open } = socketHarness();
    const connecting = transport.connect(SECRET, PCM_MEDIA);
    open();
    await connecting;
    expect(protocols[0]).toContain('openai-insecure-api-key.ek_test_secret');
  });

  it('refuses a media track — see the WebRTC counterpart', async () => {
    const { transport } = socketHarness();
    await expect(transport.connect(SECRET, MEDIA)).rejects.toThrow(/PCM/);
  });

  it('parses inbound frames', async () => {
    const { transport, open, deliver } = socketHarness();
    const seen: ServerEvent[] = [];
    transport.onEvent((event) => seen.push(event));
    const connecting = transport.connect(SECRET, PCM_MEDIA);
    open();
    await connecting;

    deliver(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    expect(seen).toContainEqual({ type: 'input_audio_buffer.speech_stopped' });
  });
});

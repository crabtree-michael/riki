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

function peer(autoOpen = true) {
  const order: string[] = [];
  let channelMessage: ((payload: string) => void) | null = null;
  const channelSends: string[] = [];
  let channelName = '';
  /** Fired by the test to mean the DTLS/SCTP handshake finished — see `openChannel` below. */
  let channelOpen: (() => void) | null = null;
  let connectionState: ((state: string) => void) | null = null;

  const channel: DataChannelLike = {
    send: (payload) => channelSends.push(payload),
    onMessage: (listener): Unsubscribe => {
      channelMessage = listener;
      return () => {
        channelMessage = null;
      };
    },
    onOpen: (listener): Unsubscribe => {
      channelOpen = listener;
      // A real channel opens on its own once the handshake lands, so the default stub does too —
      // otherwise every test here would have to know about a step it is not about. The one test
      // that *is* about it passes `autoOpen: false` and fires it by hand.
      if (autoOpen) setTimeout(listener, 0);
      return () => {
        channelOpen = null;
      };
    },
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
    onConnectionStateChange: (listener): Unsubscribe => {
      connectionState = listener;
      return () => {
        connectionState = null;
      };
    },
    close: () => order.push('peer.close'),
  };

  return {
    connection,
    order,
    channelSends,
    channelName: () => channelName,
    deliver: (payload: string) => channelMessage?.(payload),
    openChannel: () => channelOpen?.(),
    /** `RTCPeerConnection.connectionState`, as the browser adapter forwards it. */
    setConnectionState: (state: string) => connectionState?.(state),
    isWatchingConnection: () => connectionState !== null,
  };
}

function harness(response = { ok: true, status: 200, body: 'v=0 answer' }, autoOpen = true) {
  const p = peer(autoOpen);
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

  /**
   * Measured on 2026-08-04, on a real session, and the whole reason `session-lost` fired within a
   * millisecond of every match opening: the SDP answer completes *signalling*, and the data channel
   * opens later, when the DTLS/SCTP handshake finishes. Reporting `open` at `setRemoteDescription`
   * meant `createRealtimeSession` immediately sent its config on a channel still in `connecting`,
   * which throws `RTCDataChannel.readyState is not 'open'` — so the session degraded before it had
   * ever carried an event and Riki could not speak for the rest of the match.
   *
   * The WebSocket transport has always awaited its `onOpen`. This is the same wait, one transport
   * over.
   */
  it('does not report open until the data channel has opened', async () => {
    const { transport, openChannel } = harness(undefined, false);
    const states: string[] = [];
    transport.onStateChange((state) => states.push(state));

    const connecting = transport.connect(SECRET, MEDIA);
    // Flush the macrotask queue, not three microtasks: the offer/answer round trip is several
    // awaits deep and a short tick count passes this test without ever reaching the point it is
    // about. Signalling is done here; the channel is not open.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).not.toContain('open');

    openChannel();
    await connecting;
    expect(states).toContain('open');
  });

  /**
   * The subscription that was missing on 2026-08-09 (ADR-0045).
   *
   * `PeerConnectionLike.onConnectionStateChange` and `peer.ts`'s adapter for it both existed and
   * nothing called either. So when the session hit the 60-minute cap and the peer connection died,
   * this transport stayed `open` forever — `closed` was reachable only from `close()` and from a
   * refused SDP POST — and every layer above kept sending into a channel that was gone.
   */
  it('reports closed when the peer connection fails', async () => {
    const { transport, setConnectionState } = harness();
    await transport.connect(SECRET, MEDIA);
    const states: string[] = [];
    transport.onStateChange((state) => states.push(state));

    setConnectionState('failed');
    expect(states).toEqual(['closed']);
  });

  /**
   * `disconnected` is recoverable: ICE reports it after a few missed consent checks and returns to
   * `connected` once the network settles. Renewing a working session on a two-second Wi-Fi blip
   * would cost the conversation for nothing, and if it does not recover ICE gives up on its own and
   * arrives as `failed`.
   */
  it('does not report closed for a transient ICE disconnect', async () => {
    const { transport, setConnectionState } = harness();
    await transport.connect(SECRET, MEDIA);
    const states: string[] = [];
    transport.onStateChange((state) => states.push(state));

    setConnectionState('disconnected');
    setConnectionState('connected');
    expect(states).toEqual([]);
  });

  it('stops watching the peer before closing it, so our own teardown is not an unsolicited close', async () => {
    // `peer.close()` fires `connectionstatechange` with `closed`. Left subscribed, every orderly
    // close — a match ending, a renewal replacing the session — would look like a session lost,
    // and renewal would be a loop rather than a repair.
    const { transport, isWatchingConnection } = harness();
    await transport.connect(SECRET, MEDIA);
    expect(isWatchingConnection()).toBe(true);

    await transport.close('match ended');
    expect(isWatchingConnection()).toBe(false);
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

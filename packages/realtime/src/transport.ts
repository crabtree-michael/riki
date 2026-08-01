/**
 * The transport seam: one interface, three implementations.
 *
 * WebRTC is the product path (ADR-0002) and owns the peer connection, the `oai-events` data
 * channel — the name is not negotiable — and the SDP exchange. WebSocket exists because
 * `RIKI_REALTIME_TRANSPORT` exists, and on it we own PCM framing, jitter and manual barge-in
 * truncation. `FakeRealtimeTransport` replays `fixtures/realtime/*` and records what we sent,
 * which is what makes the schema assertion testable at all (REPO_SKELETON.md §5.2).
 *
 * The interface deliberately does **not** abstract over media. The two transports take different
 * media arguments because a `MediaStreamTrack` and a chunk of PCM are not the same thing, and
 * pretending otherwise would put a fake abstraction exactly where the real difference is.
 *
 * See docs/design/voice-input-architecture.md §5.2.
 */

import type { MonoMs, Unsubscribe } from './types.js';
import { parseServerEvent } from './wire.js';
import type { ClientSecret } from './credentials.js';
import type { ClientEvent, ServerEvent } from './wire.js';

export type TransportState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

/**
 * ⚠ `OutboundTrack` and `RemoteTrack` are `@riki/audio`'s opaque media handles. They are declared
 * structurally here rather than imported because a package-to-package import needs a project
 * reference that does not exist while both packages are contracts; the shapes are identical and
 * the import replaces this at step 7.
 */
export interface OutboundTrack {
  readonly id: string;
}

export interface RemoteTrack {
  readonly id: string;
}

export type TransportMedia =
  | {
      readonly kind: 'track';
      readonly outbound: OutboundTrack;
      readonly onRemoteTrack: (track: RemoteTrack) => void;
    }
  | {
      readonly kind: 'pcm';
      readonly outbound: AsyncIterable<Int16Array>;
      readonly onOutputAudio: (chunk: Int16Array) => void;
    };

export interface RealtimeTransport {
  readonly kind: 'webrtc' | 'websocket' | 'fake';
  connect(secret: ClientSecret, media: TransportMedia): Promise<void>;
  /**
   * Fire and forget onto the event bus. It does not return a promise on purpose: the API is
   * asynchronous and interleaved (realtime §1), so a `send` that resolved would be inventing a
   * request/response relationship that does not exist.
   */
  send(event: ClientEvent): void;
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
  onStateChange(listener: (state: TransportState) => void): Unsubscribe;
  close(reason: string): Promise<void>;
}

export interface WebRtcTransportOptions {
  readonly callsUrl: string;
  /** Must be `oai-events`; a field so a test can assert we did not rename it. */
  readonly dataChannelName: string;
  readonly connectTimeoutMs: number;
}

export interface WebSocketTransportOptions {
  readonly url: string;
  readonly connectTimeoutMs: number;
  /** 24 kHz mono PCM16 LE both ways on this path (realtime §3). */
  readonly sampleRate: 24000;
}

// -----------------------------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------------------------

export const OAI_EVENT_CHANNEL = 'oai-events';
export const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
export const REALTIME_WEBSOCKET_URL = 'wss://api.openai.com/v1/realtime';

export const DEFAULT_WEBRTC_OPTIONS: WebRtcTransportOptions = {
  callsUrl: REALTIME_CALLS_URL,
  dataChannelName: OAI_EVENT_CHANNEL,
  connectTimeoutMs: 10_000,
};

/**
 * The browser primitives, structurally.
 *
 * `packages/*` carries `lib: ["ES2023"]`, so `RTCPeerConnection` and `WebSocket` cannot be named
 * here (types.ts explains the same wall for media handles). Injecting them is not only a
 * workaround: it is what lets the whole negotiation sequence — offer, POST, answer, channel open
 * — be asserted in a Tier 1 test with no network and no browser.
 */
export interface PeerConnectionLike {
  createDataChannel(label: string): DataChannelLike;
  createOffer(): Promise<{ readonly sdp: string }>;
  setLocalDescription(offer: { readonly sdp: string }): Promise<void>;
  setRemoteDescription(answer: { readonly type: 'answer'; readonly sdp: string }): Promise<void>;
  addTrack(track: OutboundTrack): void;
  onTrack(listener: (track: RemoteTrack) => void): Unsubscribe;
  onConnectionStateChange(listener: (state: string) => void): Unsubscribe;
  close(): void;
}

export interface DataChannelLike {
  send(payload: string): void;
  onMessage(listener: (payload: string) => void): Unsubscribe;
  onOpen(listener: () => void): Unsubscribe;
  close(): void;
}

export interface SocketLike {
  send(payload: string): void;
  onMessage(listener: (payload: string) => void): Unsubscribe;
  onOpen(listener: () => void): Unsubscribe;
  onClose(listener: () => void): Unsubscribe;
  close(): void;
}

export interface WebRtcTransportDeps {
  readonly createPeerConnection: () => PeerConnectionLike;
  readonly fetch: (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    },
  ) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;
  readonly now: () => MonoMs;
  readonly options?: WebRtcTransportOptions;
}

interface TransportInternals {
  readonly listeners: Set<(event: ServerEvent) => void>;
  readonly stateListeners: Set<(state: TransportState) => void>;
}

function internals(): TransportInternals {
  return { listeners: new Set(), stateListeners: new Set() };
}

export function createWebRtcTransport(deps: WebRtcTransportDeps): RealtimeTransport {
  const options = deps.options ?? DEFAULT_WEBRTC_OPTIONS;
  const { listeners, stateListeners } = internals();

  let peer: PeerConnectionLike | null = null;
  let channel: DataChannelLike | null = null;

  const setState = (next: TransportState): void => {
    for (const listener of stateListeners) listener(next);
  };

  const deliver = (payload: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      // A frame we cannot parse is not a reason to drop the session. It becomes `unhandled`.
      raw = { type: 'unparseable' };
    }
    const event = parseServerEvent(raw, deps.now());
    for (const listener of listeners) listener(event);
  };

  return {
    kind: 'webrtc',

    async connect(secret, media) {
      if (media.kind !== 'track') {
        throw new Error('The WebRTC transport takes a media track, not PCM.');
      }
      setState('connecting');

      const connection = deps.createPeerConnection();
      peer = connection;
      connection.onTrack(media.onRemoteTrack);
      connection.addTrack(media.outbound);

      // The channel must be created *before* the offer, or it is not in the SDP and the server
      // has nothing to answer with. And the name is fixed by the API — `dataChannelName` is a
      // field only so a test can assert we did not rename it.
      const events = connection.createDataChannel(options.dataChannelName);
      channel = events;
      events.onMessage(deliver);

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      const response = await deps.fetch(options.callsUrl, {
        method: 'POST',
        headers: {
          // The ephemeral secret, never the key (ADR-0015). This code runs in a renderer.
          Authorization: `Bearer ${secret.value}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!response.ok) {
        setState('closed');
        throw new Error(`Realtime call setup failed (HTTP ${String(response.status)}).`);
      }

      await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
      setState('open');
    },

    send(event) {
      channel?.send(JSON.stringify(event));
    },

    close() {
      setState('closing');
      channel?.close();
      peer?.close();
      channel = null;
      peer = null;
      setState('closed');
      return Promise.resolve();
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}

export interface WebSocketTransportDeps {
  readonly connect: (url: string, protocols: readonly string[]) => SocketLike;
  readonly now: () => MonoMs;
  readonly options?: WebSocketTransportOptions;
}

export const DEFAULT_WEBSOCKET_OPTIONS: WebSocketTransportOptions = {
  url: REALTIME_WEBSOCKET_URL,
  connectTimeoutMs: 10_000,
  sampleRate: 24000,
};

/**
 * Kept because `RIKI_REALTIME_TRANSPORT` exists and ADR-0002 wants the path exercisable — not
 * because it is a peer of the WebRTC one. research §2 is explicit that it is "not recommended for
 * live audio capture": TCP head-of-line blocking means one lost packet stalls the stream, and we
 * inherit jitter buffering, playback scheduling and manual barge-in truncation.
 */
export function createWebSocketTransport(deps: WebSocketTransportDeps): RealtimeTransport {
  const options = deps.options ?? DEFAULT_WEBSOCKET_OPTIONS;
  const { listeners, stateListeners } = internals();

  let socket: SocketLike | null = null;

  const setState = (next: TransportState): void => {
    for (const listener of stateListeners) listener(next);
  };

  return {
    kind: 'websocket',

    // `async`, so a wrong-media call *rejects* rather than throwing synchronously. The signature
    // promises a `Promise<void>`; a sync throw escapes the caller's `.catch()` and surfaces
    // somewhere unrelated.
    async connect(secret, media) {
      if (media.kind !== 'pcm') {
        throw new Error('The WebSocket transport takes PCM, not a media track.');
      }
      setState('connecting');

      const opened = deps.connect(options.url, [
        'realtime',
        `openai-insecure-api-key.${secret.value}`,
      ]);
      socket = opened;

      opened.onMessage((payload) => {
        let raw: unknown;
        try {
          raw = JSON.parse(payload);
        } catch {
          raw = { type: 'unparseable' };
        }
        const event = parseServerEvent(raw, deps.now());
        for (const listener of listeners) listener(event);
      });
      opened.onClose(() => {
        setState('closed');
      });

      await new Promise<void>((resolve) => {
        opened.onOpen(() => {
          setState('open');
          resolve();
        });
      });
    },

    send(event) {
      socket?.send(JSON.stringify(event));
    },

    close() {
      setState('closing');
      socket?.close();
      socket = null;
      setState('closed');
      return Promise.resolve();
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}

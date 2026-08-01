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
 * See docs/design/voice-input-architecture.md §5.2. Declarations only.
 */

import type { Unsubscribe } from './types.js';
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

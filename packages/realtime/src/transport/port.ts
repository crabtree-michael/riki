/**
 * The transport seam.
 *
 * ADR-0002 makes WebRTC the transport, for the reasons openai-realtime-research.md §2 gives:
 * jitter buffering, packet-loss concealment and echo cancellation are handled for us, and §11.5
 * documents self-interruption loops as a *reliable* failure without AEC. WebSocket is kept
 * because §2 is equally clear that it is the right shape when the audio is already on your side
 * of the wire — which is exactly the replay path, and what `FakeRealtimeTransport` models.
 *
 * The interface is deliberately narrow: send an event, receive events, close. Everything else —
 * SDP negotiation, `getUserMedia`, the media element — belongs to the adapter in the voice window
 * (ADR-0010), because none of it can be exercised in a test that REPO_SKELETON.md §5.2 permits.
 */

import type { ClientEvent } from '../protocol/ga-schema.js';
import type { RealtimeFault, TransportKind, Unsubscribe } from '../types.js';

export type TransportState = 'idle' | 'connecting' | 'open' | 'closed';

export interface RealtimeTransport {
  readonly kind: TransportKind;
  readonly state: TransportState;

  connect(): Promise<void>;
  /**
   * Fire-and-forget by design. The Realtime API is an event bus (§1), not request/response —
   * there is nothing to await, and a transport that returned a promise here would invite the
   * dropped-`await` bug that `no-floating-promises` exists to prevent (REPO_SKELETON.md §6.2).
   */
  send(event: ClientEvent): void;
  close(): Promise<void>;

  /** Raw server frames, already JSON-parsed. Interpretation is `protocol/server-events.ts`'s job. */
  onEvent(fn: (raw: unknown) => void): Unsubscribe;
  onFault(fn: (fault: RealtimeFault) => void): Unsubscribe;
  onStateChange(fn: (state: TransportState) => void): Unsubscribe;

  /**
   * Only meaningful on WebRTC, where the assistant's audio arrives on a media track rather than
   * as events. The voice window reports playback progress here so barge-in can compute a
   * plausible `audio_end_ms` (§4). Null on transports where audio is in-band.
   */
  readonly playbackPositionMs?: () => number | null;
}

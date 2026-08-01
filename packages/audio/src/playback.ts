/**
 * How much of Riki's answer the player actually heard.
 *
 * `conversation.item.truncate` needs an `audio_end_ms`, and getting it wrong corrupts every later
 * turn in the session (openai-realtime-research.md §4): too high and the model believes it said
 * things that were cut off, too low and it repeats itself. Under WebRTC the audio arrives as RTP
 * rather than as events, so there are no deltas to count — the only honest measurement is of the
 * output itself.
 *
 * So: an analyser on the remote track, accumulating milliseconds above a silence floor, reset at
 * each response. That includes jitter-buffer delay and excludes trailing silence, which is exactly
 * the quantity meant. It also produces the output envelope the chip's bars use during Speaking, so
 * the barge-in machinery and the display signal are one measurement rather than two.
 *
 * This is the only place in Riki that analyses an output signal, and it analyses Riki's own voice.
 * There is no capture path for game audio anywhere in this package, which is how
 * dota2-state-capture-design.md §7's "voice chat is never captured" stays true by construction.
 *
 * See docs/design/voice-input-architecture.md §4.3. Declarations only.
 */

import type { ItemId, LevelSample, RemoteTrack, ResponseId, Unsubscribe } from './types.js';

export interface PlaybackReport {
  readonly responseId: ResponseId;
  readonly itemId: ItemId;
  readonly audibleMs: number;
  readonly interrupted: boolean;
}

export interface PlaybackTrackerOptions {
  /** Default -50 dBFS. Silence between phrases must not be counted as heard. */
  readonly silenceFloorDb: number;
  readonly frameMs: number;
}

export interface PlaybackTracker {
  attach(track: RemoteTrack): void;
  beginResponse(responseId: ResponseId, itemId: ItemId): void;
  /** Valid mid-response: this is the number the truncate is sent with. */
  audibleMs(): number;
  endResponse(interrupted: boolean): PlaybackReport;
  onLevel(listener: (sample: LevelSample) => void): Unsubscribe;
  dispose(): void;
}

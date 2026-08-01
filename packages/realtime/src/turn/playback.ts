/**
 * Playback accounting, so barge-in can send a truthful `conversation.item.truncate`.
 *
 * This is the file the `voice-realtime` skill warns about: *"Barge-in without
 * `conversation.item.truncate` corrupts every later turn."* The model's idea of what it said has
 * to match what the user actually heard. Skip the truncate and every subsequent turn is built on
 * the premise that Riki delivered a sentence the player interrupted three words into.
 *
 * ## Why this exists even though ADR-0002 chose WebRTC
 *
 * openai-realtime-research.md §4 says barge-in on WebRTC is "handled server-side… Nothing to do",
 * and reading only that sentence would make this file look like dead weight. It is not, and the
 * reason is a genuine interaction between two decisions taken in different documents:
 *
 * - §4's automatic truncation is triggered by **server VAD noticing the user speak**.
 * - ADR-0004 makes push-to-talk the default, which means `turn_detection: null` — **there is no
 *   server VAD running at all.**
 *
 * So the server cannot detect the interruption, because the only thing that knows the user
 * interrupted is Riki's hotkey. On our configuration the truncate is manual on *every* transport.
 * See ADR-0017.
 */

import { truncateItem, type TruncateItemEvent } from '../protocol/ga-schema.js';
import { ASSISTANT_AUDIO_TOKENS_PER_MS, type Millis } from '../types.js';

export interface PlaybackTrackerOptions {
  /**
   * WebRTC only: the voice window's view of how far into the track playback has reached. When
   * present it wins, because it is the only source that reflects what came out of the speakers
   * rather than what we handed to the transport.
   */
  readonly positionMs?: () => number | null;
}

/**
 * Tracks the assistant's current audio item and how much of it the user has actually heard.
 *
 * Three sources of truth, in descending order of trustworthiness:
 *   1. the transport's playback position (real output),
 *   2. bytes of audio we have been sent and queued (WebSocket path),
 *   3. wall-clock since the item started (fallback).
 */
export class PlaybackTracker {
  readonly #positionMs: (() => number | null) | null;

  #itemId: string | null = null;
  #startedAt: Millis | null = null;
  #queuedMs = 0;
  #generatedMs: Millis | null = null;

  constructor(options: PlaybackTrackerOptions = {}) {
    this.#positionMs = options.positionMs ?? null;
  }

  get itemId(): string | null {
    return this.#itemId;
  }

  get speaking(): boolean {
    return this.#itemId !== null;
  }

  begin(itemId: string, at: Millis): void {
    this.#itemId = itemId;
    this.#startedAt = at;
    this.#queuedMs = 0;
    this.#generatedMs = null;
  }

  /** WebSocket path: PCM16 at 24 kHz is 48 bytes per millisecond. */
  noteAudioBytes(bytes: number): void {
    this.#queuedMs += bytes / 48;
  }

  /** `response.output_audio.done` tells us how much audio exists in total. */
  noteGeneratedMs(durationMs: Millis | null): void {
    if (durationMs !== null) this.#generatedMs = durationMs;
  }

  end(): void {
    this.#itemId = null;
    this.#startedAt = null;
    this.#queuedMs = 0;
    this.#generatedMs = null;
  }

  /**
   * How much the user heard, clamped to what actually exists.
   *
   * The clamp is the "plausible" in REPO_SKELETON.md §5.4's "a plausible `audio_end_ms`". An
   * `audio_end_ms` past the end of the item is rejected by the API, and one derived from wall
   * clock will overshoot whenever playback lagged generation — which is most of the time, since
   * audio arrives faster than it plays.
   */
  playedMs(at: Millis): Millis {
    const reported = this.#positionMs?.() ?? null;
    const elapsed = this.#startedAt === null ? 0 : Math.max(0, at - this.#startedAt);

    const best = reported ?? (this.#queuedMs > 0 ? Math.min(this.#queuedMs, elapsed) : elapsed);
    const ceiling = this.#generatedMs ?? Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(best, ceiling));
  }

  /** Null when nothing is playing — an interrupt with no active item needs no truncate. */
  truncateFor(at: Millis): TruncateItemEvent | null {
    if (this.#itemId === null) return null;
    return truncateItem(this.#itemId, this.playedMs(at));
  }

  /**
   * What the interrupted audio actually cost. §10 bills assistant audio at 1 token per 50 ms, and
   * we are billed for what was generated, not for what was heard — so a user who barges in early
   * saves latency, not money. Keeping the distinction visible is the point of `cost/meter.ts`.
   */
  generatedTokens(): number {
    return (this.#generatedMs ?? this.#queuedMs) * ASSISTANT_AUDIO_TOKENS_PER_MS;
  }
}

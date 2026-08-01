/**
 * Rate conversion between the device (typically 48 kHz) and the API's 24 kHz PCM16.
 *
 * **This does not run on the product's default path.** Under WebRTC (ADR-0002) Chromium encodes
 * Opus and no PCM passes through our code at all. It runs on the WebSocket path
 * (`RIKI_REALTIME_TRANSPORT=websocket`, which ADR-0002 keeps so that path stays exercisable) and
 * in every fixture-driven test, because `fixtures/realtime/*` was recorded at 24 kHz.
 *
 * That is worth knowing before deciding the round-trip tone test is theatre: a resampling bug does
 * not throw, it pitch-shifts, and a pitch-shifted session sounds like a bad model rather than like
 * a bug (openai-realtime-research.md §3; REPO_SKELETON.md §5.4 names the test).
 *
 * See docs/design/voice-input-architecture.md §4.2. Declarations only.
 */

/** One-shot conversion. Correct only for a complete signal — see `StreamingResampler`. */
export declare function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array;

/** Little-endian 16-bit, which is what `audio/pcm` means on the wire (realtime §3). */
export declare function floatToPcm16(input: Float32Array): Int16Array;

export declare function pcm16ToFloat(input: Int16Array): Float32Array;

/**
 * A class, and only because fractional phase has to survive between calls.
 *
 * Resampling each frame independently drops or duplicates a fraction of a sample per frame. Per
 * frame that is inaudible; over a 40-minute match it is a slow drift plus a periodic click, and it
 * is the one bug in this file that a single-frame test cannot see. The Tier 1 test pushes a
 * thousand chunks and asserts continuity across every boundary.
 */
export interface StreamingResampler {
  push(frame: Float32Array): Float32Array;
  /** Emits whatever the carried phase still holds. Call once, at the end of an utterance. */
  flush(): Float32Array;
  reset(): void;
}

export declare function createStreamingResampler(
  fromRate: number,
  toRate: number,
): StreamingResampler;

/**
 * The vocabulary shared across @riki/audio.
 *
 * Every signal path in this package is **mono**. The Realtime API's PCM leg is mono 24 kHz
 * (openai-realtime-research.md §3) and the chip's bars are one number per frame, so there is no
 * point in this package at which a channel count is a variable. If stereo ever arrives it is
 * downmixed at the source adapter, before anything here sees it.
 */

export type Hertz = number;
export type Millis = number;

/**
 * Every subscription in this package returns its own disposer. Deliberately identical in shape to
 * the overlay's `Unsubscribe` but declared separately: `packages/*` may not import from `apps/*`
 * (REPO_SKELETON.md §6.2), and a shared alias would be the first thing to violate it.
 */
export type Unsubscribe = () => void;

/** Normalised linear amplitude, 0..1. What `LevelFrame.value` carries. */
export type Level = number;

export type Decibels = number;

/**
 * Mono PCM in the range −1..1. `Float32Array` rather than `number[]` throughout: these buffers
 * are allocated per chunk on the audio path, and the typed array is what every browser audio API
 * hands us anyway.
 */
export type MonoFrame = Float32Array;

/** The rate the Realtime API's PCM leg runs at, and the only rate it accepts (research §3). */
export const REALTIME_SAMPLE_RATE = 24_000 as const;

/**
 * What a capture device typically runs at. Not assumed anywhere — the resampler takes both rates
 * as parameters — but it is the default the fakes and the round-trip test use.
 */
export const TYPICAL_DEVICE_SAMPLE_RATE = 48_000 as const;

/**
 * @riki/audio
 *
 * Device enumeration, RMS and envelope maths for the chip's level bars, resampling between the
 * device rate and the Realtime API's, earcons, and ducking.
 *
 * Resampling errors here produce pitch-shifted audio rather than an error, so the round-trip
 * tone test in REPO_SKELETON.md §5.4 is not optional — see `resample/resampler.test.ts`.
 *
 * Two things to know before changing anything here:
 *
 * - **Nothing in this package reads a global.** No `process`, no `navigator`, no `AudioContext`,
 *   no clock. Time and rates arrive as parameters and devices arrive as ports, which is what
 *   makes the whole package a Tier 1 test with no browser and no microphone (§5.2).
 * - **Ducking is a no-op on macOS, by design and not by omission.** See `ducking/controller.ts`,
 *   ADR-0016, and docs/research/audio-ducking-platform-support.md before "fixing" it.
 *
 * The class decomposition is recorded in ADR-0017.
 */

export * from './types.js';

export * from './pcm/codec.js';
export * from './resample/resampler.js';

export * from './levels/envelope.js';
export * from './levels/pump.js';
export * from './levels/silence.js';

export * from './earcons/synth.js';
export * from './ducking/controller.js';

export * from './capture/ports.js';
export * from './capture/stream.js';

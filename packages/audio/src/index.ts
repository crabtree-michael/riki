/**
 * @riki/audio
 *
 * Device enumeration, RMS and envelope maths for the chip's level bars, resampling between the
 * device rate and the Realtime API's, earcons, and ducking.
 *
 * Resampling errors here produce pitch-shifted audio rather than an error, so the round-trip
 * tone test in REPO_SKELETON.md §5.4 is not optional — and note that under WebRTC (ADR-0002) the
 * resampler does not run on the product's default path at all. `resample.ts` says why that does
 * not make the test theatre.
 *
 * **Ducking is a no-op on macOS, by design and not by omission** (ADR-0020,
 * docs/research/audio-ducking-platform-support.md). Read those before "fixing" it.
 *
 * Implemented: the pure maths (`level`), rate conversion and PCM framing (`resample`), the
 * playback measurement barge-in depends on (`playback`), the ducking policy (`ducking`), and the
 * earcon specification table. Still contracts: `device` and `capture`, whose implementations need
 * `getUserMedia` and an `AudioContext` and therefore land with the voice window
 * (REPO_SKELETON.md §10 step 6/7). §15 of the design document maps each section to a file here.
 */

export type * from './types.js';
export type * from './device.js';
export type * from './capture.js';

export * from './level.js';
export * from './resample.js';
export * from './playback.js';
export * from './earcons.js';
export * from './ducking.js';

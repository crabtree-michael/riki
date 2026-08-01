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
 * Contracts only — no behaviour yet. Every `declare`d function is a signature waiting for
 * REPO_SKELETON.md §10 step 7; the shapes are docs/design/voice-input-architecture.md §3, §4 and
 * §7.1, and §15 of that document maps each section to a file here.
 */

export type * from './types.js';
export type * from './device.js';
export type * from './capture.js';
export type * from './level.js';
export type * from './resample.js';
export type * from './playback.js';
export type * from './earcons.js';
export type * from './ducking.js';

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
 * Fully implemented. `DeviceRegistry` and `CaptureGraph` take `navigator.mediaDevices` and the
 * Web Audio nodes through structural ports rather than naming them, so the gate, the pre-roll and
 * the device swap are all Tier 1 tests with no browser and no microphone. The one thing still
 * outstanding is `EarconPlayer`, which needs a real `AudioContext` to make a sound and lands with
 * the voice window; the specification table it plays from is here.
 * §15 of the design document maps each section to a file here.
 */

export type * from './types.js';

export * from './device.js';
export * from './capture.js';
export * from './level.js';
export * from './resample.js';
export * from './playback.js';
export * from './earcons.js';
export * from './ducking.js';

/**
 * Level maths — pure, and the most-tested code in this package.
 *
 * Everything here is a total function of a `Float32Array` and some numbers, which is what lets the
 * chip's bars, the silence nudge and the 8-second listen timeout all be Tier 1 tests against
 * `FakeAudioDevice`'s known PCM rather than something only observable with a microphone.
 *
 * See docs/design/voice-input-architecture.md §7.1.
 */

import type { LevelSample } from './types.js';

/** Root mean square of a frame, 0..1. The bars' signal, and the silence detector's input. */
export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

/** Absolute peak of a frame, 0..1. Clipping detection, not display. */
export function peak(frame: Float32Array): number {
  let highest = 0;
  for (const sample of frame) {
    const magnitude = Math.abs(sample);
    if (magnitude > highest) highest = magnitude;
  }
  return highest;
}

/**
 * Amplitude (0..1) to dBFS. Returns -Infinity at zero, which callers must handle.
 *
 * -Infinity rather than a floor is deliberate and is what the contract says: a floor is a display
 * decision, and this is a measurement. `isSilent` compares against a threshold, where -Infinity
 * behaves correctly; the overlay's ballistics do their own clamping (overlay-architecture §7.4).
 */
export function dbfs(amplitude: number): number {
  if (amplitude <= 0) return -Infinity;
  return 20 * Math.log10(amplitude);
}

/**
 * Below the floor for the purposes of `speech.silence`.
 *
 * A threshold, not a VAD: it answers "is anything arriving" and nothing about whether it is
 * speech. The server's VAD answers the second question (ADR-0017), and the two must not be
 * conflated — this one has to work with the gate closed, where by construction nothing is speech.
 */
export function isSilent(sample: LevelSample, floorDb: number): boolean {
  return dbfs(sample.rms) < floorDb;
}

/**
 * Attack and release differ because they model different things: a level meter must rise fast
 * enough to catch a consonant and fall slowly enough to be readable. Used for the output envelope
 * during Speaking; the chip's own ballistics are the renderer's (overlay-architecture.md §7.4).
 */
export interface EnvelopeOptions {
  readonly attackMs: number;
  readonly releaseMs: number;
  /** How much time one call represents. A one-pole coefficient is meaningless without it. */
  readonly frameMs: number;
}

/**
 * One-pole follower.
 *
 * The coefficient is `1 - exp(-dt / tau)` rather than a fixed per-frame fraction, so the same
 * signal reaches the same level in the same wall-clock time whatever the frame size. A follower
 * tuned against 128-sample quanta and then run at 480 behaves completely differently otherwise,
 * and the frame size here is not ours to fix — it is whatever the device hands back.
 */
export function envelope(previous: number, target: number, opts: EnvelopeOptions): number {
  const tau = target > previous ? opts.attackMs : opts.releaseMs;
  const alpha = tau <= 0 || opts.frameMs <= 0 ? 1 : 1 - Math.exp(-opts.frameMs / tau);
  const next = previous + (target - previous) * alpha;
  // Snap to zero rather than resting on a residue that keeps the bars faintly lit forever.
  return target === 0 && next < 1e-4 ? 0 : next;
}

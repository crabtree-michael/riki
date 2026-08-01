/**
 * Level maths — pure, and the most-tested code in this package.
 *
 * Everything here is a total function of a `Float32Array` and some numbers, which is what lets the
 * chip's bars, the silence nudge and the 8-second listen timeout all be Tier 1 tests against
 * `FakeAudioDevice`'s known PCM rather than something only observable with a microphone.
 *
 * See docs/design/voice-input-architecture.md §7.1. Declarations only.
 */

import type { LevelSample } from './types.js';

/** Root mean square of a frame, 0..1. The bars' signal, and the silence detector's input. */
export declare function rms(frame: Float32Array): number;

/** Absolute peak of a frame, 0..1. Clipping detection, not display. */
export declare function peak(frame: Float32Array): number;

/** Amplitude (0..1) to dBFS. Returns -Infinity at zero, which callers must handle. */
export declare function dbfs(amplitude: number): number;

/**
 * Below the floor for the purposes of `speech.silence`.
 *
 * A threshold, not a VAD: it answers "is anything arriving" and nothing about whether it is
 * speech. The server's VAD answers the second question (ADR-0017), and the two must not be
 * conflated — this one has to work with the gate closed, where by construction nothing is speech.
 */
export declare function isSilent(sample: LevelSample, floorDb: number): boolean;

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

export declare function envelope(previous: number, target: number, opts: EnvelopeOptions): number;

/**
 * RMS and envelope maths for the chip's amplitude bars.
 *
 * The `voice-realtime` skill flags this as the UI hot path: mic level drives the bars, so this
 * runs per audio chunk for the whole time the chip is visible, and ui-design.md §8 gives it a
 * ≤250 ms budget from key-down to "the bars respond to my voice". Everything here is therefore
 * allocation-free per call and unit-testable without a device.
 *
 * The ballistics matter more than they look. Raw RMS mapped straight to bar height reads as
 * jitter rather than as speech — the eye wants a fast attack so a syllable lands immediately, and
 * a slow release so the bar decays smoothly between them instead of strobing at word rate.
 */

import type { Decibels, Level, Millis, MonoFrame } from '../types.js';

export function rms(frame: MonoFrame): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

/** Floors at −100 dBFS rather than returning −Infinity for digital silence. */
export function toDbfs(amplitude: number): Decibels {
  if (amplitude <= 1e-5) return -100;
  return 20 * Math.log10(amplitude);
}

export function fromDbfs(db: Decibels): number {
  return Math.pow(10, db / 20);
}

export interface EnvelopeOptions {
  /** Time to rise to ~63 % of a step. Short: a syllable should register on its first frame. */
  readonly attackMs?: Millis;
  /** Time to fall to ~37 %. Long enough to bridge the gaps between words. */
  readonly releaseMs?: Millis;
  /**
   * The dBFS window mapped onto the bars' 0..1. Speech at a sane input gain sits around −30 to
   * −12 dBFS; anchoring the floor at −60 means room tone does not light the bars up.
   */
  readonly floorDb?: Decibels;
  readonly ceilingDb?: Decibels;
}

const DEFAULTS = {
  attackMs: 10,
  releaseMs: 180,
  floorDb: -60,
  ceilingDb: -6,
} as const;

/**
 * One-pole attack/release follower over RMS, mapped to 0..1 on a dB scale.
 *
 * dB rather than linear is the non-obvious part: the ear is logarithmic, and a linear mapping
 * spends nine tenths of the bar's travel on the top 20 dB, so normal speech barely moves it and
 * users conclude the mic is not working.
 */
export class EnvelopeFollower {
  readonly #attackMs: Millis;
  readonly #releaseMs: Millis;
  readonly #floorDb: Decibels;
  readonly #ceilingDb: Decibels;
  #value = 0;

  constructor(options: EnvelopeOptions = {}) {
    this.#attackMs = options.attackMs ?? DEFAULTS.attackMs;
    this.#releaseMs = options.releaseMs ?? DEFAULTS.releaseMs;
    this.#floorDb = options.floorDb ?? DEFAULTS.floorDb;
    this.#ceilingDb = options.ceilingDb ?? DEFAULTS.ceilingDb;
  }

  /** `dtMs` is the wall time the chunk covers, so the ballistics are rate-independent. */
  push(frame: MonoFrame, dtMs: Millis): Level {
    return this.pushLevel(this.#normalise(rms(frame)), dtMs);
  }

  /** For callers that already have a normalised level — the output leg reads one from the API. */
  pushLevel(target: Level, dtMs: Millis): Level {
    const timeConstant = target > this.#value ? this.#attackMs : this.#releaseMs;
    // A zero or negative dt must not divide by zero or run the filter backwards.
    const alpha = timeConstant <= 0 || dtMs <= 0 ? 1 : 1 - Math.exp(-dtMs / timeConstant);
    this.#value += (target - this.#value) * alpha;
    if (this.#value < 1e-4) this.#value = 0;
    return this.#value;
  }

  get value(): Level {
    return this.#value;
  }

  reset(): void {
    this.#value = 0;
  }

  #normalise(amplitude: number): Level {
    const db = toDbfs(amplitude);
    const span = this.#ceilingDb - this.#floorDb;
    if (span <= 0) return 0;
    const scaled = (db - this.#floorDb) / span;
    return scaled < 0 ? 0 : scaled > 1 ? 1 : scaled;
  }
}

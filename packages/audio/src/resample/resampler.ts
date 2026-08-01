/**
 * Band-limited resampling between the device rate and the Realtime API's 24 kHz.
 *
 * This is the single most dangerous file in the package, for the reason
 * openai-realtime-research.md §3 gives and the `voice-realtime` skill repeats: **a wrong
 * resampler produces pitch-shifted audio, not an exception.** Nothing crashes, no event fires,
 * the level bars move, and the model simply mishears everything. The guarding test is a
 * round-trip on a known tone asserting frequency within tolerance (REPO_SKELETON.md §5.4), and
 * it is why the implementation below is a real windowed-sinc filter rather than the sample
 * dropping that "48 000 is exactly twice 24 000" invites.
 *
 * Naive decimation is the trap specifically. Dropping every other sample of 48 kHz audio is
 * correct only if there is nothing above 12 kHz — and a close-talk microphone in a room with
 * game audio in it always has something above 12 kHz. That content aliases down into the speech
 * band as a metallic whistle that survives every subjective "sounds fine to me" check.
 */

import type { Hertz, MonoFrame } from '../types.js';

/**
 * Half the tap count. 16 gives a transition band narrow enough that nothing audible aliases at
 * the 2:1 ratio we actually run, at 32 multiply-adds per output sample — roughly 0.8 M/s on the
 * capture leg, which is not measurable next to the encode that follows it.
 */
const HALF_WIDTH = 16;

/**
 * Fractional positions the filter is precomputed at. The phase is quantised to 1/256 of a sample
 * rather than evaluated per output, which turns a `Math.sin` per tap into an array read. At
 * 24 kHz the residual phase error is ~0.16 µs, far below anything the ear or the model resolves.
 */
const PHASE_STEPS = 256;

function sinc(x: number): number {
  if (x === 0) return 1;
  const piX = Math.PI * x;
  return Math.sin(piX) / piX;
}

/** Blackman. Chosen over Hann for its −58 dB sidelobes: aliasing here is inaudible, not merely low. */
function blackman(n: number, width: number): number {
  const ratio = n / width;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * ratio) + 0.08 * Math.cos(4 * Math.PI * ratio);
}

/**
 * `taps[phase * tapCount + j]` is the filter weight for input sample `j - HALF_WIDTH + 1`
 * relative to the integer part of the source position.
 */
function buildTaps(ratio: number): Float32Array {
  const tapCount = HALF_WIDTH * 2;
  // Downsampling moves the anti-alias cutoff down with the ratio; upsampling leaves it at
  // Nyquist so the filter interpolates without also imaging.
  const cutoff = ratio < 1 ? 0.5 * ratio : 0.5;
  const taps = new Float32Array(PHASE_STEPS * tapCount);

  for (let phase = 0; phase < PHASE_STEPS; phase += 1) {
    const frac = phase / PHASE_STEPS;
    let sum = 0;
    for (let j = 0; j < tapCount; j += 1) {
      const offset = frac - (j - HALF_WIDTH + 1);
      const weight =
        2 * cutoff * sinc(2 * cutoff * offset) * blackman(offset + HALF_WIDTH, tapCount);
      taps[phase * tapCount + j] = weight;
      sum += weight;
    }
    // Normalise each phase to unit DC gain. Without this the quantised phases have slightly
    // different gains and the output acquires a faint buzz at the resampling frequency.
    if (sum !== 0) {
      for (let j = 0; j < tapCount; j += 1) {
        taps[phase * tapCount + j] = (taps[phase * tapCount + j] ?? 0) / sum;
      }
    }
  }
  return taps;
}

/** Taps depend only on the ratio, and a session uses one or two. Building them is ~1 ms. */
const tapCache = new Map<number, Float32Array>();

function tapsFor(ratio: number): Float32Array {
  const key = Math.round(ratio * 1e6) / 1e6;
  const cached = tapCache.get(key);
  if (cached) return cached;
  const built = buildTaps(key);
  tapCache.set(key, built);
  return built;
}

export interface Resampler {
  /** Feed a chunk, get whatever output it completed. Length varies; zero is normal and fine. */
  process(input: MonoFrame): MonoFrame;
  /** Drain the filter's tail at end of stream, padding the right context with silence. */
  flush(): MonoFrame;
  reset(): void;
  readonly inputRate: Hertz;
  readonly outputRate: Hertz;
}

class SincResampler implements Resampler {
  readonly #taps: Float32Array;
  readonly #tapCount = HALF_WIDTH * 2;
  readonly #step: number;

  /** Unconsumed input plus the left context the next output sample needs. */
  #tail: Float32Array;
  /** Position of the next output sample, in `#tail` coordinates. */
  #phase: number;

  constructor(
    readonly inputRate: Hertz,
    readonly outputRate: Hertz,
  ) {
    if (!(inputRate > 0) || !(outputRate > 0)) {
      throw new RangeError(
        `Sample rates must be positive, got ${String(inputRate)} → ${String(outputRate)}`,
      );
    }
    this.#step = inputRate / outputRate;
    this.#taps = tapsFor(outputRate / inputRate);
    this.#tail = new Float32Array(HALF_WIDTH);
    this.#phase = HALF_WIDTH;
  }

  process(input: MonoFrame): MonoFrame {
    if (input.length === 0) return new Float32Array(0);

    const buffer = new Float32Array(this.#tail.length + input.length);
    buffer.set(this.#tail, 0);
    buffer.set(input, this.#tail.length);

    // An output sample is producible once its right context is in the buffer.
    const limit = buffer.length - HALF_WIDTH;
    const capacity = Math.max(0, Math.ceil((limit - this.#phase) / this.#step));
    const out = new Float32Array(capacity);
    let produced = 0;

    while (this.#phase < limit) {
      out[produced] = this.#sampleAt(buffer, this.#phase);
      produced += 1;
      this.#phase += this.#step;
    }

    // Keep HALF_WIDTH samples of left context for the next call; drop the rest.
    const consumed = Math.max(0, Math.floor(this.#phase) - HALF_WIDTH);
    this.#tail = buffer.slice(consumed);
    this.#phase -= consumed;

    return produced === capacity ? out : out.subarray(0, produced);
  }

  flush(): MonoFrame {
    // Silence supplies the right context the real stream no longer has.
    return this.process(new Float32Array(HALF_WIDTH));
  }

  reset(): void {
    this.#tail = new Float32Array(HALF_WIDTH);
    this.#phase = HALF_WIDTH;
  }

  #sampleAt(buffer: Float32Array, position: number): number {
    const base = Math.floor(position);
    const frac = position - base;
    const phase = Math.min(PHASE_STEPS - 1, Math.floor(frac * PHASE_STEPS));
    const tapBase = phase * this.#tapCount;
    const start = base - HALF_WIDTH + 1;

    let acc = 0;
    for (let j = 0; j < this.#tapCount; j += 1) {
      acc += (buffer[start + j] ?? 0) * (this.#taps[tapBase + j] ?? 0);
    }
    return acc;
  }
}

/**
 * Returns a pass-through when the rates already match, which is the common case on a device that
 * happens to run at 24 kHz — and means callers never have to ask whether they need one.
 */
export function createResampler(inputRate: Hertz, outputRate: Hertz): Resampler {
  if (inputRate === outputRate) return new PassThroughResampler(inputRate);
  return new SincResampler(inputRate, outputRate);
}

class PassThroughResampler implements Resampler {
  constructor(private readonly rate: Hertz) {}
  get inputRate(): Hertz {
    return this.rate;
  }
  get outputRate(): Hertz {
    return this.rate;
  }
  process(input: MonoFrame): MonoFrame {
    return input;
  }
  flush(): MonoFrame {
    return new Float32Array(0);
  }
  reset(): void {
    /* stateless */
  }
}

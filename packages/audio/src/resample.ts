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
 * See docs/design/voice-input-architecture.md §4.2.
 *
 * ## Why a windowed sinc rather than dropping every other sample
 *
 * 48 000 is exactly twice 24 000, which makes decimation look free. It is not. Dropping alternate
 * samples is correct only if there is nothing above 12 kHz, and a close-talk microphone in a room
 * with game audio in it always has something above 12 kHz. That content folds down into the speech
 * band as a metallic whistle which survives every subjective "sounds fine to me" check — hence the
 * anti-aliasing assertion in the test, which pushes 15 kHz through and checks it does *not*
 * reappear at 9 kHz.
 */

/**
 * Half the tap count. 16 gives a transition band narrow enough that nothing audible aliases at the
 * 2:1 ratio we actually run, at 32 multiply-adds per output sample.
 */
const HALF_WIDTH = 16;

/**
 * Fractional positions the filter is precomputed at, so the inner loop is an array read rather
 * than a `Math.sin`. At 24 kHz the residual phase error is ~0.16 µs.
 */
const PHASE_STEPS = 256;

function sinc(x: number): number {
  if (x === 0) return 1;
  const piX = Math.PI * x;
  return Math.sin(piX) / piX;
}

/** Blackman: −58 dB sidelobes, so rejected content is inaudible rather than merely low. */
function blackman(n: number, width: number): number {
  const ratio = n / width;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * ratio) + 0.08 * Math.cos(4 * Math.PI * ratio);
}

/** `taps[phase * tapCount + j]` weights input sample `j - HALF_WIDTH + 1` from the integer base. */
function buildTaps(ratio: number): Float32Array {
  const tapCount = HALF_WIDTH * 2;
  // Downsampling moves the anti-alias cutoff down with the ratio; upsampling leaves it at Nyquist
  // so the filter interpolates without also imaging.
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
    // Normalise each phase to unit DC gain: without it the quantised phases have slightly
    // different gains and the output acquires a faint buzz at the resampling frequency.
    if (sum !== 0) {
      for (let j = 0; j < tapCount; j += 1) {
        taps[phase * tapCount + j] = (taps[phase * tapCount + j] ?? 0) / sum;
      }
    }
  }
  return taps;
}

/** Taps depend only on the ratio, and a session uses one or two. */
const tapCache = new Map<number, Float32Array>();

function tapsFor(ratio: number): Float32Array {
  const key = Math.round(ratio * 1e6) / 1e6;
  const cached = tapCache.get(key);
  if (cached) return cached;
  const built = buildTaps(key);
  tapCache.set(key, built);
  return built;
}

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

class SincResampler implements StreamingResampler {
  readonly #taps: Float32Array;
  readonly #tapCount = HALF_WIDTH * 2;
  readonly #step: number;

  /** Unconsumed input plus the left context the next output sample needs. */
  #tail: Float32Array;
  /** Position of the next output sample, in `#tail` coordinates. */
  #phase: number;

  constructor(fromRate: number, toRate: number) {
    this.#step = fromRate / toRate;
    this.#taps = tapsFor(toRate / fromRate);
    this.#tail = new Float32Array(HALF_WIDTH);
    this.#phase = HALF_WIDTH;
  }

  push(frame: Float32Array): Float32Array {
    if (frame.length === 0) return new Float32Array(0);

    const buffer = new Float32Array(this.#tail.length + frame.length);
    buffer.set(this.#tail, 0);
    buffer.set(frame, this.#tail.length);

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

  flush(): Float32Array {
    // Silence supplies the right context the real stream no longer has.
    return this.push(new Float32Array(HALF_WIDTH));
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

class PassThroughResampler implements StreamingResampler {
  push(frame: Float32Array): Float32Array {
    return frame;
  }
  flush(): Float32Array {
    return new Float32Array(0);
  }
  reset(): void {
    /* stateless */
  }
}

export function createStreamingResampler(fromRate: number, toRate: number): StreamingResampler {
  if (!(fromRate > 0) || !(toRate > 0)) {
    throw new RangeError(
      `Sample rates must be positive, got ${String(fromRate)} → ${String(toRate)}`,
    );
  }
  // A pass-through when the rates match means callers never have to ask whether they need one.
  if (fromRate === toRate) return new PassThroughResampler();
  return new SincResampler(fromRate, toRate);
}

/** One-shot conversion. Correct only for a complete signal — see `StreamingResampler`. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const resampler = createStreamingResampler(fromRate, toRate);
  const body = resampler.push(input);
  const tail = resampler.flush();
  if (tail.length === 0) return body;

  const out = new Float32Array(body.length + tail.length);
  out.set(body, 0);
  out.set(tail, body.length);
  return out;
}

/**
 * Two's complement gives one more negative step than positive, so scaling both directions by
 * 32767 wastes a step and scaling both by 32768 clips the positive peak.
 */
const PCM16_MAX = 0x7fff;
const PCM16_MIN_MAGNITUDE = 0x8000;

/** Little-endian 16-bit, which is what `audio/pcm` means on the wire (realtime §3). */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] ?? 0;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    out[i] = Math.round(clamped < 0 ? clamped * PCM16_MIN_MAGNITUDE : clamped * PCM16_MAX);
  }
  return out;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] ?? 0;
    out[i] = sample < 0 ? sample / PCM16_MIN_MAGNITUDE : sample / PCM16_MAX;
  }
  return out;
}

/**
 * Byte order is written explicitly rather than taken as a view over the buffer.
 * `new Uint8Array(samples.buffer)` inherits the host's endianness, so it is correct on every
 * machine we develop on and wrong on the one we do not. The API does not reject a big-endian
 * buffer — it decodes it as full-scale noise, which reads as a broken microphone rather than as a
 * wrong codec.
 */
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i] ?? 0, true);
  }
  return out;
}

export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Int16Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

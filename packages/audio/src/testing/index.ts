/**
 * Shared fakes for @riki/audio, exported as `@riki/audio/testing`.
 *
 * These are not test scaffolding: `pnpm dev:replay` drives the whole app through the same
 * fakes, which is what keeps them honest (REPO_SKELETON.md §5.2). No test may require a
 * running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * `FakeAudioDevice` is one of the four fakes §5.2 names: it "feeds known PCM, captures output
 * for the resampling tests".
 *
 * The analysis helpers below live here rather than in a test file because the round-trip tone
 * assertion §5.4 asks for needs a frequency estimator, and the next package (or the next agent)
 * checking a resampling claim should not have to write one again.
 */

import type {
  AudioDeviceEnumerator,
  AudioDeviceInfo,
  AudioFault,
  AudioSourcePort,
  CapturedChunk,
} from '../capture/ports.js';
import type { Hertz, Millis, MonoFrame, Unsubscribe } from '../types.js';

export interface ToneOptions {
  readonly frequency: Hertz;
  readonly sampleRate: Hertz;
  readonly durationMs: Millis;
  readonly amplitude?: number;
  readonly phase?: number;
}

export function generateTone(options: ToneOptions): MonoFrame {
  const { frequency, sampleRate, durationMs } = options;
  const amplitude = options.amplitude ?? 0.5;
  const phase = options.phase ?? 0;
  const count = Math.round((durationMs / 1000) * sampleRate);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = Math.sin(phase + 2 * Math.PI * frequency * (i / sampleRate)) * amplitude;
  }
  return out;
}

export function generateSilence(sampleRate: Hertz, durationMs: Millis): MonoFrame {
  return new Float32Array(Math.round((durationMs / 1000) * sampleRate));
}

/** Hann. Sidelobes low enough that a single tone's peak is unambiguous at this resolution. */
function hann(i: number, n: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
}

/**
 * Peak of the magnitude spectrum, refined by parabolic interpolation on the log magnitudes.
 *
 * A plain bin argmax is not enough for the resampling test: over 100 ms the bins are 10 Hz
 * apart, so a tolerance tight enough to be meaningful would be unassertable and a resampler that
 * shifted a tone by half a bin would pass. Interpolation gets a clean tone to well under a hertz,
 * which is what makes the tolerance mean something.
 */
export function dominantFrequency(frame: MonoFrame, sampleRate: Hertz): Hertz {
  const n = frame.length;
  if (n < 4) return 0;

  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i += 1) windowed[i] = (frame[i] ?? 0) * hann(i, n);

  const bins = Math.floor(n / 2);
  const magnitude = new Float64Array(bins);
  for (let k = 1; k < bins; k += 1) {
    let re = 0;
    let im = 0;
    const step = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i += 1) {
      const angle = step * i;
      const sample = windowed[i] ?? 0;
      re += sample * Math.cos(angle);
      im -= sample * Math.sin(angle);
    }
    magnitude[k] = Math.sqrt(re * re + im * im);
  }

  let peak = 1;
  for (let k = 2; k < bins; k += 1) {
    if ((magnitude[k] ?? 0) > (magnitude[peak] ?? 0)) peak = k;
  }
  if (peak <= 1 || peak >= bins - 1) return (peak * sampleRate) / n;

  const epsilon = 1e-12;
  const left = Math.log((magnitude[peak - 1] ?? 0) + epsilon);
  const centre = Math.log((magnitude[peak] ?? 0) + epsilon);
  const right = Math.log((magnitude[peak + 1] ?? 0) + epsilon);
  const denominator = left - 2 * centre + right;
  const offset = denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;

  return ((peak + offset) * sampleRate) / n;
}

/** Peak absolute sample. Asserts a resampler introduced neither gain nor clipping. */
export function peakAmplitude(frame: MonoFrame): number {
  let peak = 0;
  for (const sample of frame) {
    const value = Math.abs(sample);
    if (value > peak) peak = value;
  }
  return peak;
}

export interface FakeAudioDeviceOptions {
  readonly sampleRate?: Hertz;
  /** Samples per emitted chunk. Defaults to 10 ms, the order Chromium delivers in practice. */
  readonly chunkSize?: number;
  /** Make `start()` reject, to exercise the fault path without a real permission prompt. */
  readonly failOnStart?: AudioFault;
}

/**
 * Replaces the mic. `pump()` is explicit rather than timer-driven, so tests stay deterministic
 * and need no fake clock.
 */
export class FakeAudioDevice implements AudioSourcePort {
  readonly sampleRate: Hertz;
  readonly #chunkSize: number;
  readonly #failOnStart: AudioFault | undefined;
  readonly #frameListeners = new Set<(chunk: CapturedChunk) => void>();
  readonly #faultListeners = new Set<(fault: AudioFault) => void>();

  #started = false;
  #clock: Millis = 0;

  /** Everything handed to `pump()`, concatenated — the input side of a round-trip assertion. */
  readonly emitted: number[] = [];

  constructor(options: FakeAudioDeviceOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48_000;
    this.#chunkSize = options.chunkSize ?? Math.round(this.sampleRate / 100);
    this.#failOnStart = options.failOnStart;
  }

  get started(): boolean {
    return this.#started;
  }

  start(): Promise<void> {
    if (this.#failOnStart) return Promise.reject(new Error(this.#failOnStart.message));
    this.#started = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.#started = false;
    return Promise.resolve();
  }

  onFrame(fn: (chunk: CapturedChunk) => void): Unsubscribe {
    this.#frameListeners.add(fn);
    return () => this.#frameListeners.delete(fn);
  }

  onFault(fn: (fault: AudioFault) => void): Unsubscribe {
    this.#faultListeners.add(fn);
    return () => this.#faultListeners.delete(fn);
  }

  /** Feed a signal through in device-sized chunks, advancing the fake clock as a device would. */
  pump(frame: MonoFrame): void {
    for (let offset = 0; offset < frame.length; offset += this.#chunkSize) {
      const chunk = frame.subarray(offset, Math.min(offset + this.#chunkSize, frame.length));
      for (const sample of chunk) this.emitted.push(sample);
      const at = this.#clock;
      this.#clock += (chunk.length / this.sampleRate) * 1000;
      for (const listener of this.#frameListeners) listener({ frame: chunk, at });
    }
  }

  emitFault(fault: AudioFault): void {
    for (const listener of this.#faultListeners) listener(fault);
  }
}

/** Collects everything a capture stream produced, so a test can assert on the whole signal. */
export class RecordingChunkSink {
  readonly chunks: MonoFrame[] = [];

  append(frame: MonoFrame): void {
    this.chunks.push(frame);
  }

  concat(): MonoFrame {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  clear(): void {
    this.chunks.length = 0;
  }
}

const DEFAULT_DEVICES: readonly AudioDeviceInfo[] = [
  { id: 'default-in', label: 'MacBook Pro Microphone', kind: 'input', isDefault: true },
  { id: 'default-out', label: 'MacBook Pro Speakers', kind: 'output', isDefault: true },
];

export class FakeDeviceEnumerator implements AudioDeviceEnumerator {
  readonly #listeners = new Set<() => void>();
  #devices: readonly AudioDeviceInfo[];

  constructor(devices: readonly AudioDeviceInfo[] = DEFAULT_DEVICES) {
    this.#devices = devices;
  }

  list(): Promise<readonly AudioDeviceInfo[]> {
    return Promise.resolve(this.#devices);
  }

  onChanged(fn: () => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  setDevices(devices: readonly AudioDeviceInfo[]): void {
    this.#devices = devices;
    for (const listener of this.#listeners) listener();
  }
}

/** Records what the ducking controller asked the platform to do. */
export class RecordingDuckingBackend {
  readonly calls: ({ readonly kind: 'apply' | 'release' } & { readonly rampMs: number })[] = [];
  disposed = false;

  constructor(readonly availability: 'full' | 'system-controlled' = 'full') {}

  apply(_depthDb: number, rampMs: number): void {
    this.calls.push({ kind: 'apply', rampMs });
  }

  release(rampMs: number): void {
    this.calls.push({ kind: 'release', rampMs });
  }

  dispose(): void {
    this.disposed = true;
  }
}

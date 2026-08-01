/**
 * Shared fakes for @riki/audio, exported as `@riki/audio/testing`.
 *
 * These are not test scaffolding: `pnpm dev:replay` drives the whole app through the same
 * fakes, which is what keeps them honest (REPO_SKELETON.md §5.2). No test may require a
 * running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * `FakeAudioDevice` is the one fake in the set that *generates* its input rather than replaying a
 * recording: tones and PCM are produced deterministically in the test rather than committed,
 * because a committed binary that exists to check arithmetic is a fixture nobody can read in a
 * diff (docs/design/voice-input-architecture.md §11).
 *
 * `FakeAudioDevice` and `createFakeCaptureGraph` remain contracts — they are built over
 * `CaptureGraph`, whose implementation needs an `AudioContext` and lands with the voice window.
 * The signal generators and the analysis helpers below are implemented, because the resampling,
 * level and playback tests need them now and none of them touches a device.
 */

import type { CaptureGraph } from '../capture.js';
import type { LevelSample, MicStream, Unsubscribe } from '../types.js';

export interface ToneSpec {
  readonly hz: number;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly amplitude: number;
}

export interface FakeAudioDevice {
  /** What a `CaptureGraph` is built over. Nothing here touches a real device. */
  readonly stream: MicStream;

  /** Deterministic. The input to the round-trip resampling test (REPO_SKELETON.md §5.4). */
  pushTone(spec: ToneSpec): void;
  pushSilence(durationMs: number): void;
  pushFrames(frames: readonly Float32Array[]): void;

  /**
   * Everything that reached the outbound track. The privacy assertion in architecture §11 —
   * gate closed means no signal leaves — is a statement about this array.
   */
  outbound(): readonly Float32Array[];
  levels(): readonly LevelSample[];

  /** Device departure and arrival, for the swap path (architecture §3.5). */
  detach(): void;
  attach(): MicStream;

  onDispose(listener: () => void): Unsubscribe;
}

export declare function createFakeAudioDevice(sampleRate?: number): FakeAudioDevice;

// -----------------------------------------------------------------------------------------------
// Signal generation and analysis — implemented, and device-free
// -----------------------------------------------------------------------------------------------

export function generateTone(spec: ToneSpec): Float32Array {
  const count = Math.round((spec.durationMs / 1000) * spec.sampleRate);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = Math.sin(2 * Math.PI * spec.hz * (i / spec.sampleRate)) * spec.amplitude;
  }
  return out;
}

export function generateSilence(sampleRate: number, durationMs: number): Float32Array {
  return new Float32Array(Math.round((durationMs / 1000) * sampleRate));
}

/** Hann. Sidelobes low enough that a single tone's peak is unambiguous at this resolution. */
function hann(i: number, n: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
}

/**
 * Peak of the magnitude spectrum, refined by parabolic interpolation on the log magnitudes.
 *
 * A bare bin argmax is not enough for the resampling test: over a short window the bins are ~6 Hz
 * apart, so a tolerance tight enough to be meaningful would be unassertable and a resampler that
 * shifted a tone by half a bin would pass. Interpolation gets a clean tone to well under a hertz.
 *
 * ⚠ Naive O(n²) DFT. Bound the window you pass in — an unbounded 250 ms buffer at 48 kHz turns a
 * Tier 1 test into a four-second one. 4096 samples is plenty.
 */
export function dominantFrequency(frame: Float32Array, sampleRate: number): number {
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

  let top = 1;
  for (let k = 2; k < bins; k += 1) {
    if ((magnitude[k] ?? 0) > (magnitude[top] ?? 0)) top = k;
  }
  if (top <= 1 || top >= bins - 1) return (top * sampleRate) / n;

  const epsilon = 1e-12;
  const left = Math.log((magnitude[top - 1] ?? 0) + epsilon);
  const centre = Math.log((magnitude[top] ?? 0) + epsilon);
  const right = Math.log((magnitude[top + 1] ?? 0) + epsilon);
  const denominator = left - 2 * centre + right;
  const offset = denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;

  return ((top + offset) * sampleRate) / n;
}

export function peakAmplitude(frame: Float32Array): number {
  let highest = 0;
  for (const sample of frame) {
    const magnitude = Math.abs(sample);
    if (magnitude > highest) highest = magnitude;
  }
  return highest;
}

/** Concatenate the chunks a streaming resampler produced, for a whole-signal assertion. */
export function concatFrames(frames: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/** A `CaptureGraph` over a `FakeAudioDevice`, with an injected clock. No `AudioContext` anywhere. */
export declare function createFakeCaptureGraph(device: FakeAudioDevice): CaptureGraph;

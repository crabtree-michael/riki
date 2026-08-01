/**
 * The test REPO_SKELETON.md §5.4 asks for by name:
 *
 * > Round-trip 48 kHz → 24 kHz → 48 kHz on a known tone; assert frequency within tolerance.
 * > The doc explicitly asks for this test.
 *
 * The risk it guards is that a wrong resampler is *silent*: openai-realtime-research.md §3 and
 * the `voice-realtime` skill both note that the failure is pitch-shifted audio, not an
 * exception. Nothing throws, the bars still move, and the model simply mishears.
 */

import { describe, expect, it } from 'vitest';
import { createResampler } from './resampler.js';
import { REALTIME_SAMPLE_RATE, TYPICAL_DEVICE_SAMPLE_RATE } from '../types.js';
import {
  dominantFrequency,
  generateTone,
  peakAmplitude,
  type ToneOptions,
} from '../testing/index.js';

const DEVICE_RATE = TYPICAL_DEVICE_SAMPLE_RATE;
const WIRE_RATE = REALTIME_SAMPLE_RATE;

/** Long enough that the DFT resolves a tone sharply; short enough to stay a millisecond test. */
const DURATION_MS = 250;

function tone(frequency: number, sampleRate: number): Float32Array {
  const options: ToneOptions = { frequency, sampleRate, durationMs: DURATION_MS, amplitude: 0.5 };
  return generateTone(options);
}

/**
 * Drop the filter's start-up transient, then bound the window.
 *
 * The bound is about test cost, not correctness: `dominantFrequency` is a naive O(n²) DFT, so an
 * unbounded 250 ms window at 48 kHz turns a Tier 1 test into a four-second one. 4096 samples
 * still resolves a clean tone to well under a hertz after parabolic interpolation.
 */
const ANALYSIS_WINDOW = 4096;

function steadyState(frame: Float32Array, sampleRate: number): Float32Array {
  const skip = Math.round(sampleRate * 0.02);
  const end = Math.min(frame.length - skip, skip + ANALYSIS_WINDOW);
  return frame.subarray(skip, end);
}

describe('round-trip through the Realtime rate', () => {
  // 440 is the canonical case; the others bracket the speech band, where being wrong matters.
  it.each([220, 440, 1000, 3000])('preserves a %i Hz tone', (frequency) => {
    const down = createResampler(DEVICE_RATE, WIRE_RATE);
    const up = createResampler(WIRE_RATE, DEVICE_RATE);

    const wire = down.process(tone(frequency, DEVICE_RATE));
    const back = up.process(wire);

    expect(dominantFrequency(steadyState(wire, WIRE_RATE), WIRE_RATE)).toBeCloseTo(frequency, 0);
    expect(dominantFrequency(steadyState(back, DEVICE_RATE), DEVICE_RATE)).toBeCloseTo(
      frequency,
      0,
    );
  });

  it('produces the expected number of samples on each leg', () => {
    const down = createResampler(DEVICE_RATE, WIRE_RATE);
    const input = tone(440, DEVICE_RATE);

    const wire = down.process(input);
    const drained = down.flush();
    const total = wire.length + drained.length;

    // Half the input, within one filter's worth of latency.
    expect(total).toBeGreaterThan(input.length / 2 - 40);
    expect(total).toBeLessThan(input.length / 2 + 40);
  });

  it('does not add gain or clip', () => {
    const down = createResampler(DEVICE_RATE, WIRE_RATE);
    const wire = down.process(tone(440, DEVICE_RATE));
    expect(peakAmplitude(steadyState(wire, WIRE_RATE))).toBeLessThanOrEqual(0.55);
    expect(peakAmplitude(steadyState(wire, WIRE_RATE))).toBeGreaterThan(0.45);
  });
});

describe('chunked input matches a single pass', () => {
  /**
   * The real capture path never hands over a whole utterance at once — it arrives in 10 ms
   * chunks. A resampler that keeps no left context across calls still passes a single-shot tone
   * test and then produces a click at every chunk boundary in production.
   */
  it('is identical whether fed in one buffer or in 10 ms chunks', () => {
    const input = tone(440, DEVICE_RATE);

    const oneShot = createResampler(DEVICE_RATE, WIRE_RATE).process(input);

    const streaming = createResampler(DEVICE_RATE, WIRE_RATE);
    const chunkSize = DEVICE_RATE / 100;
    const pieces: Float32Array[] = [];
    for (let offset = 0; offset < input.length; offset += chunkSize) {
      pieces.push(streaming.process(input.subarray(offset, offset + chunkSize)));
    }

    const joined = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
    let cursor = 0;
    for (const piece of pieces) {
      joined.set(piece, cursor);
      cursor += piece.length;
    }

    expect(joined.length).toBe(oneShot.length);
    for (let i = 0; i < joined.length; i += 1) {
      expect(joined[i] ?? 0).toBeCloseTo(oneShot[i] ?? 0, 6);
    }
  });
});

describe('anti-aliasing', () => {
  /**
   * The reason this is a sinc filter rather than "take every other sample". A 9 kHz tone is
   * above the 12 kHz Nyquist of the *output* rate... it is not, but 15 kHz is — and naive
   * decimation folds it down to 9 kHz, squarely into the speech band, where it survives every
   * subjective "sounds fine to me" check as a metallic whistle.
   */
  it('rejects content above the output Nyquist instead of folding it into the speech band', () => {
    const down = createResampler(DEVICE_RATE, WIRE_RATE);
    const out = steadyState(down.process(tone(15_000, DEVICE_RATE)), WIRE_RATE);

    // Naive decimation would alias 15 kHz → 9 kHz at roughly full amplitude.
    expect(peakAmplitude(out)).toBeLessThan(0.02);
  });

  it('passes content well inside the band at full amplitude', () => {
    const down = createResampler(DEVICE_RATE, WIRE_RATE);
    const out = steadyState(down.process(tone(2_000, DEVICE_RATE)), WIRE_RATE);
    expect(peakAmplitude(out)).toBeGreaterThan(0.45);
  });
});

describe('createResampler', () => {
  it('returns a pass-through when the rates already match', () => {
    const resampler = createResampler(WIRE_RATE, WIRE_RATE);
    const input = tone(440, WIRE_RATE);
    expect(resampler.process(input)).toBe(input);
    expect(resampler.flush().length).toBe(0);
  });

  it('handles a non-integer ratio — 44.1 kHz is the common macOS laptop mic rate', () => {
    const down = createResampler(44_100, WIRE_RATE);
    const out = down.process(tone(440, 44_100));
    expect(dominantFrequency(steadyState(out, WIRE_RATE), WIRE_RATE)).toBeCloseTo(440, 0);
  });

  it('rejects a non-positive rate rather than producing silence', () => {
    expect(() => createResampler(0, WIRE_RATE)).toThrow(RangeError);
    expect(() => createResampler(DEVICE_RATE, -1)).toThrow(RangeError);
  });

  it('reset() clears the tail so a new turn does not inherit the last one', () => {
    const resampler = createResampler(DEVICE_RATE, WIRE_RATE);
    resampler.process(tone(440, DEVICE_RATE));
    resampler.reset();

    const fresh = createResampler(DEVICE_RATE, WIRE_RATE).process(tone(440, DEVICE_RATE));
    const afterReset = resampler.process(tone(440, DEVICE_RATE));
    expect(afterReset.length).toBe(fresh.length);
    expect(afterReset[0] ?? 0).toBeCloseTo(fresh[0] ?? 0, 6);
  });
});

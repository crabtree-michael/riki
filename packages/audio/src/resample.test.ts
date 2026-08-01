/**
 * The test REPO_SKELETON.md §5.4 asks for by name:
 *
 * > Round-trip 48 kHz → 24 kHz → 48 kHz on a known tone; assert frequency within tolerance.
 *
 * The risk is that a wrong resampler is *silent* (openai-realtime-research.md §3): nothing throws,
 * the bars still move, and the model simply mishears. `resample.ts` explains why this is not
 * theatre even though the resampler is off the WebRTC path.
 */

import { describe, expect, it } from 'vitest';
import {
  bytesToPcm16,
  createStreamingResampler,
  floatToPcm16,
  pcm16ToBytes,
  pcm16ToFloat,
  resample,
} from './resample.js';
import { concatFrames, dominantFrequency, generateTone, peakAmplitude } from './testing/index.js';

const DEVICE_RATE = 48_000;
const WIRE_RATE = 24_000;
const DURATION_MS = 250;

function tone(hz: number, sampleRate: number): Float32Array {
  return generateTone({ hz, sampleRate, durationMs: DURATION_MS, amplitude: 0.5 });
}

/**
 * Drop the filter's start-up transient, then bound the window: `dominantFrequency` is a naive
 * O(n²) DFT, so an unbounded buffer turns a Tier 1 test into a four-second one.
 */
const ANALYSIS_WINDOW = 4096;

function steadyState(frame: Float32Array, sampleRate: number): Float32Array {
  const skip = Math.round(sampleRate * 0.02);
  return frame.subarray(skip, Math.min(frame.length - skip, skip + ANALYSIS_WINDOW));
}

describe('round-trip through the API rate', () => {
  it.each([220, 440, 1000, 3000])('preserves a %i Hz tone', (hz) => {
    const wire = resample(tone(hz, DEVICE_RATE), DEVICE_RATE, WIRE_RATE);
    const back = resample(wire, WIRE_RATE, DEVICE_RATE);

    expect(dominantFrequency(steadyState(wire, WIRE_RATE), WIRE_RATE)).toBeCloseTo(hz, 0);
    expect(dominantFrequency(steadyState(back, DEVICE_RATE), DEVICE_RATE)).toBeCloseTo(hz, 0);
  });

  it('halves the sample count going down, within a filter of latency', () => {
    const input = tone(440, DEVICE_RATE);
    const wire = resample(input, DEVICE_RATE, WIRE_RATE);
    expect(wire.length).toBeGreaterThan(input.length / 2 - 40);
    expect(wire.length).toBeLessThan(input.length / 2 + 40);
  });

  it('adds no gain and does not clip', () => {
    const wire = steadyState(resample(tone(440, DEVICE_RATE), DEVICE_RATE, WIRE_RATE), WIRE_RATE);
    expect(peakAmplitude(wire)).toBeGreaterThan(0.45);
    expect(peakAmplitude(wire)).toBeLessThanOrEqual(0.55);
  });

  it('handles 44.1 kHz, the common macOS laptop-mic rate', () => {
    const wire = resample(tone(440, 44_100), 44_100, WIRE_RATE);
    expect(dominantFrequency(steadyState(wire, WIRE_RATE), WIRE_RATE)).toBeCloseTo(440, 0);
  });
});

describe('anti-aliasing', () => {
  /**
   * The reason this is a sinc filter rather than "take every other sample". Naive decimation folds
   * 15 kHz down to 9 kHz — squarely into the speech band, where it survives every subjective
   * "sounds fine to me" check as a metallic whistle.
   */
  it('rejects content above the output Nyquist instead of folding it into speech', () => {
    const wire = steadyState(
      resample(tone(15_000, DEVICE_RATE), DEVICE_RATE, WIRE_RATE),
      WIRE_RATE,
    );
    expect(peakAmplitude(wire)).toBeLessThan(0.02);
  });

  it('passes content well inside the band at full amplitude', () => {
    const wire = steadyState(resample(tone(2_000, DEVICE_RATE), DEVICE_RATE, WIRE_RATE), WIRE_RATE);
    expect(peakAmplitude(wire)).toBeGreaterThan(0.45);
  });
});

describe('StreamingResampler — the drift the contract warns about', () => {
  /**
   * `resample.ts`: resampling each frame independently drops or duplicates a fraction of a sample
   * per frame — inaudible per frame, a slow drift plus a periodic click over a 40-minute match,
   * and invisible to a single-frame test. So: a thousand chunks, and continuity across every one.
   */
  it('is identical fed in 1000 chunks or in one buffer', () => {
    const input = generateTone({
      hz: 440,
      sampleRate: DEVICE_RATE,
      durationMs: 1000,
      amplitude: 0.5,
    });
    const chunkSize = Math.floor(input.length / 1000);

    const oneShot = createStreamingResampler(DEVICE_RATE, WIRE_RATE).push(input);

    const streaming = createStreamingResampler(DEVICE_RATE, WIRE_RATE);
    const pieces: Float32Array[] = [];
    for (let offset = 0; offset < input.length; offset += chunkSize) {
      pieces.push(streaming.push(input.subarray(offset, offset + chunkSize)));
    }
    const joined = concatFrames(pieces);

    expect(joined.length).toBe(oneShot.length);
    for (let i = 0; i < joined.length; i += 1) {
      expect(joined[i] ?? 0).toBeCloseTo(oneShot[i] ?? 0, 6);
    }
  });

  it('does not drift over a long stream — no sample count creep', () => {
    const streaming = createStreamingResampler(DEVICE_RATE, WIRE_RATE);
    const chunk = generateSilenceChunk(480);
    let produced = 0;
    for (let i = 0; i < 1000; i += 1) produced += streaming.push(chunk).length;
    // 1000 × 480 input samples at 2:1 is 240 000 out, ± one filter's worth.
    expect(produced).toBeGreaterThan(240_000 - 40);
    expect(produced).toBeLessThan(240_000 + 40);
  });

  it('reset() clears the tail so a new utterance does not inherit the last one', () => {
    const streaming = createStreamingResampler(DEVICE_RATE, WIRE_RATE);
    streaming.push(tone(440, DEVICE_RATE));
    streaming.reset();

    const fresh = createStreamingResampler(DEVICE_RATE, WIRE_RATE).push(tone(440, DEVICE_RATE));
    const afterReset = streaming.push(tone(440, DEVICE_RATE));
    expect(afterReset.length).toBe(fresh.length);
    expect(afterReset[0] ?? 0).toBeCloseTo(fresh[0] ?? 0, 6);
  });

  it('is a pass-through when the rates already match', () => {
    const streaming = createStreamingResampler(WIRE_RATE, WIRE_RATE);
    const input = tone(440, WIRE_RATE);
    expect(streaming.push(input)).toBe(input);
    expect(streaming.flush().length).toBe(0);
  });

  it('rejects a non-positive rate rather than emitting silence', () => {
    expect(() => createStreamingResampler(0, WIRE_RATE)).toThrow(RangeError);
    expect(() => createStreamingResampler(DEVICE_RATE, -1)).toThrow(RangeError);
  });
});

function generateSilenceChunk(length: number): Float32Array {
  return new Float32Array(length);
}

describe('PCM16 framing', () => {
  it('round-trips a tone within one quantisation step', () => {
    const input = generateTone({ hz: 440, sampleRate: WIRE_RATE, durationMs: 20, amplitude: 0.5 });
    const output = pcm16ToFloat(floatToPcm16(input));
    for (let i = 0; i < input.length; i += 1) {
      expect(output[i] ?? 0).toBeCloseTo(input[i] ?? 0, 4);
    }
  });

  it('maps full scale to the full integer range without wrapping', () => {
    const encoded = floatToPcm16(new Float32Array([1, -1, 0]));
    expect(Array.from(encoded)).toEqual([32767, -32768, 0]);
  });

  it('clamps out-of-range input rather than wrapping it into loud noise', () => {
    expect(Array.from(floatToPcm16(new Float32Array([2, -2])))).toEqual([32767, -32768]);
  });

  it('writes little-endian, explicitly', () => {
    // The API does not reject a big-endian buffer — it decodes it as full-scale noise, which
    // reads as a broken microphone rather than a wrong codec.
    expect(Array.from(pcm16ToBytes(new Int16Array([0x0102])))).toEqual([0x02, 0x01]);
  });

  it('round-trips negative samples through the byte layer', () => {
    const samples = new Int16Array([-1, -32768, 32767, 0]);
    expect(Array.from(bytesToPcm16(pcm16ToBytes(samples)))).toEqual(Array.from(samples));
  });
});

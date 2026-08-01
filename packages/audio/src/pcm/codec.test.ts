import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToPcm16,
  decodeAppendPayload,
  encodeAppendPayload,
  float32ToPcm16,
  pcm16ToBytes,
  pcm16ToFloat32,
} from './codec.js';
import { generateTone } from '../testing/index.js';

describe('float32 ↔ pcm16', () => {
  it('round-trips a tone within one quantisation step', () => {
    const input = generateTone({ frequency: 440, sampleRate: 24_000, durationMs: 20 });
    const output = pcm16ToFloat32(float32ToPcm16(input));
    for (let i = 0; i < input.length; i += 1) {
      expect(output[i] ?? 0).toBeCloseTo(input[i] ?? 0, 4);
    }
  });

  it('maps full scale to the full integer range without wrapping', () => {
    const encoded = float32ToPcm16(new Float32Array([1, -1, 0]));
    expect(encoded[0]).toBe(32767);
    expect(encoded[1]).toBe(-32768);
    expect(encoded[2]).toBe(0);
  });

  it('clamps out-of-range input rather than wrapping it into loud noise', () => {
    const encoded = float32ToPcm16(new Float32Array([2, -2]));
    expect(encoded[0]).toBe(32767);
    expect(encoded[1]).toBe(-32768);
  });
});

describe('byte order', () => {
  /**
   * The failure this guards is the one openai-realtime-research.md §3 implies but does not spell
   * out: a big-endian buffer is not rejected by the API, it is *decoded as audio*. The result is
   * full-scale noise that reads as a broken microphone rather than a wrong codec.
   */
  it('writes little-endian, explicitly', () => {
    // 0x0102 little-endian is [0x02, 0x01].
    const bytes = pcm16ToBytes(new Int16Array([0x0102]));
    expect(Array.from(bytes)).toEqual([0x02, 0x01]);
  });

  it('round-trips negative samples through the byte layer', () => {
    const samples = new Int16Array([-1, -32768, 32767, 0]);
    expect(Array.from(bytesToPcm16(pcm16ToBytes(samples)))).toEqual(Array.from(samples));
  });
});

describe('base64', () => {
  it.each([
    [[], ''],
    [[0x66], 'Zg=='],
    [[0x66, 0x6f], 'Zm8='],
    [[0x66, 0x6f, 0x6f], 'Zm9v'],
    [[0x66, 0x6f, 0x6f, 0x62], 'Zm9vYg=='],
  ])('encodes %j', (bytes, expected) => {
    expect(bytesToBase64(Uint8Array.from(bytes))).toBe(expected);
  });

  it('round-trips arbitrary bytes, including the padding boundaries', () => {
    for (let length = 0; length < 16; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });
});

describe('encodeAppendPayload', () => {
  it('round-trips a tone through the whole wire encoding', () => {
    const input = generateTone({ frequency: 440, sampleRate: 24_000, durationMs: 20 });
    const output = decodeAppendPayload(encodeAppendPayload(input));
    expect(output.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 1) {
      expect(output[i] ?? 0).toBeCloseTo(input[i] ?? 0, 4);
    }
  });
});

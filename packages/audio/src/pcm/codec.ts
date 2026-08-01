/**
 * Float32 ↔ PCM16 little-endian, and base64.
 *
 * The Realtime API's PCM format is "24 kHz, mono, 16-bit **little-endian**"
 * (openai-realtime-research.md §3). Byte order is the part that fails silently: a big-endian
 * buffer decodes as loud noise rather than as an error, which reads as "the mic is broken"
 * rather than "the codec is wrong". The round-trip tests here exist to pin it.
 *
 * Base64 is hand-rolled rather than taken from `Buffer` or `btoa`. Per ADR-0010 this code runs in
 * a renderer with `contextIsolation` on and no Node integration, so `Buffer` is absent; `btoa`
 * exists but is typed as DOM and would drag the DOM lib into a package that is otherwise
 * node-testable. Twenty lines is cheaper than either.
 */

import type { MonoFrame } from '../types.js';

/**
 * Asymmetric on purpose. Two's complement gives one more negative step than positive, so scaling
 * both directions by 32767 wastes a step and scaling both by 32768 clips the positive peak.
 */
const PCM16_MAX = 0x7fff;
const PCM16_MIN_MAGNITUDE = 0x8000;

export function float32ToPcm16(frame: MonoFrame): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    const sample = frame[i] ?? 0;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    out[i] = Math.round(clamped < 0 ? clamped * PCM16_MIN_MAGNITUDE : clamped * PCM16_MAX);
  }
  return out;
}

export function pcm16ToFloat32(samples: Int16Array): MonoFrame {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    out[i] = sample < 0 ? sample / PCM16_MIN_MAGNITUDE : sample / PCM16_MAX;
  }
  return out;
}

/** Little-endian, explicitly — never `new Uint8Array(samples.buffer)`, which inherits host order. */
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

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup, built once. `-1` marks a character that is not base64. */
const BASE64_LOOKUP: readonly number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    const remaining = bytes.length - i;
    out += BASE64_ALPHABET[(triple >> 18) & 0x3f] ?? '';
    out += BASE64_ALPHABET[(triple >> 12) & 0x3f] ?? '';
    out += remaining > 1 ? (BASE64_ALPHABET[(triple >> 6) & 0x3f] ?? '') : '=';
    out += remaining > 2 ? (BASE64_ALPHABET[triple & 0x3f] ?? '') : '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[=\s]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const value = BASE64_LOOKUP[clean.charCodeAt(i)] ?? -1;
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (accumulator >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

/** The whole outbound leg in one call: what `input_audio_buffer.append` carries. */
export function encodeAppendPayload(frame: MonoFrame): string {
  return bytesToBase64(pcm16ToBytes(float32ToPcm16(frame)));
}

export function decodeAppendPayload(payload: string): MonoFrame {
  return pcm16ToFloat32(bytesToPcm16(base64ToBytes(payload)));
}

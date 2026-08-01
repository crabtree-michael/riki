import { describe, expect, it } from 'vitest';
import { DEFAULT_EARCON_LEVEL_DB, EarconPlayer, earconDurationMs, renderEarcon } from './synth.js';
import { fromDbfs } from '../levels/envelope.js';
import { dominantFrequency, peakAmplitude } from '../testing/index.js';
import type { Hertz, MonoFrame } from '../types.js';

const RATE = 48_000;

/** The blips are two 40 ms halves; analyse each separately. */
function half(frame: MonoFrame, index: 0 | 1): MonoFrame {
  const mid = Math.floor(frame.length / 2);
  const guard = Math.round(RATE * 0.006);
  return index === 0
    ? frame.subarray(guard, mid - guard)
    : frame.subarray(mid + guard, frame.length - guard);
}

describe('the three earcons from ui-design.md §7.1', () => {
  it('capture-start rises 660 → 880 Hz', () => {
    const frame = renderEarcon('capture-start', RATE);
    expect(dominantFrequency(half(frame, 0), RATE)).toBeCloseTo(660, -1);
    expect(dominantFrequency(half(frame, 1), RATE)).toBeCloseTo(880, -1);
  });

  it('capture-end falls 880 → 660 Hz — the only confirmation the mic actually closed', () => {
    const frame = renderEarcon('capture-end', RATE);
    expect(dominantFrequency(half(frame, 0), RATE)).toBeCloseTo(880, -1);
    expect(dominantFrequency(half(frame, 1), RATE)).toBeCloseTo(660, -1);
  });

  it('error is a single 330 Hz tone', () => {
    const frame = renderEarcon('error', RATE);
    const guard = Math.round(RATE * 0.01);
    expect(dominantFrequency(frame.subarray(guard, frame.length - guard), RATE)).toBeCloseTo(
      330,
      -1,
    );
  });

  it('has the durations the spec gives', () => {
    expect(earconDurationMs('capture-start')).toBe(80);
    expect(earconDurationMs('capture-end')).toBe(80);
    expect(earconDurationMs('error')).toBe(140);
  });

  it('renders at whatever rate it is asked for, so nothing resamples an earcon', () => {
    for (const rate of [24_000, 44_100, 48_000] as Hertz[]) {
      expect(renderEarcon('error', rate).length).toBe(Math.round(0.14 * rate));
    }
  });
});

describe('level and shape', () => {
  it('peaks at the −18 dBFS default', () => {
    const frame = renderEarcon('error', RATE);
    expect(peakAmplitude(frame)).toBeCloseTo(fromDbfs(DEFAULT_EARCON_LEVEL_DB), 2);
  });

  it('is independently adjustable, per §7.1', () => {
    const quiet = renderEarcon('error', RATE, { levelDb: -30 });
    expect(peakAmplitude(quiet)).toBeCloseTo(fromDbfs(-30), 2);
  });

  it('starts and ends at silence — a click is exactly the artefact this product cannot afford', () => {
    for (const id of ['capture-start', 'capture-end', 'error'] as const) {
      const frame = renderEarcon(id, RATE);
      expect(Math.abs(frame[0] ?? 0)).toBeLessThan(1e-6);
      expect(Math.abs(frame[frame.length - 1] ?? 0)).toBeLessThan(1e-3);
    }
  });
});

describe('EarconPlayer', () => {
  function recorder() {
    const played: MonoFrame[] = [];
    return { played, play: (frame: MonoFrame) => played.push(frame) };
  }

  it('renders once and reuses the buffer', () => {
    const output = recorder();
    const player = new EarconPlayer({ sampleRate: RATE, output });
    player.play('capture-start');
    player.play('capture-start');
    expect(output.played).toHaveLength(2);
    expect(output.played[0]).toBe(output.played[1]);
  });

  it('plays nothing when earcons are muted', () => {
    const output = recorder();
    const player = new EarconPlayer({ sampleRate: RATE, output, enabled: false });
    player.play('error');
    expect(output.played).toEqual([]);
  });
});

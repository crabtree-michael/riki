import { describe, expect, it } from 'vitest';

import { PULSE_DURATION_MS, createMotionDirector, settlesAtMs } from './director.js';
import type { ChipState, MotionSignature } from '../../../shared/overlay.js';

const director = createMotionDirector(5);

const VISIBLE_STATES: readonly ChipState[] = [
  'armed',
  'listening',
  'processing',
  'acting',
  'confirming',
  'speaking',
  'error',
  'muted',
];

const SIGNATURES: readonly MotionSignature[] = [
  'none',
  'amplitude',
  'sweep',
  'envelope',
  'double-pulse-then-static',
];

const NORMAL = { reducedMotion: false, highContrast: false };
const REDUCED = { reducedMotion: true, highContrast: false };

describe('signatureFor', () => {
  it('matches the signature the machine projects, so the two never disagree', () => {
    expect(director.signatureFor('listening', NORMAL)).toBe('amplitude');
    expect(director.signatureFor('processing', NORMAL)).toBe('sweep');
    expect(director.signatureFor('acting', NORMAL)).toBe('sweep');
    expect(director.signatureFor('speaking', NORMAL)).toBe('envelope');
    expect(director.signatureFor('error', NORMAL)).toBe('double-pulse-then-static');
    expect(director.signatureFor('confirming', NORMAL)).toBe('none');
    expect(director.signatureFor('muted', NORMAL)).toBe('none');
  });

  it('makes reduced motion a variant of every state, not a global off switch', () => {
    for (const state of VISIBLE_STATES) {
      const reduced = director.signatureFor(state, REDUCED);
      expect(SIGNATURES).toContain(reduced);
      // Every looping signature goes static; the double-pulse is already an opacity step.
      if (reduced !== 'none') expect(reduced).toBe('double-pulse-then-static');
    }
  });

  it('keeps the amplitude bars as information under reduced motion', () => {
    const sample = director.sample(director.signatureFor('listening', REDUCED), 0, 0.7);
    expect(sample.barScales).toHaveLength(1);
    expect(sample.barScales[0]).toBeCloseTo(0.7, 5);
  });
});

describe('sample — purity', () => {
  it('is deterministic for a given t and level', () => {
    for (const signature of SIGNATURES) {
      for (const t of [0, 17, 400, 1_337, 9_001]) {
        expect(director.sample(signature, t, 0.42)).toEqual(director.sample(signature, t, 0.42));
      }
    }
  });

  it('never leaves the unit range', () => {
    for (const signature of SIGNATURES) {
      for (const t of [0, 100, 600, 1_200, 5_000]) {
        for (const level of [0, 0.01, 0.5, 1]) {
          const sample = director.sample(signature, t, level);
          for (const scale of sample.barScales) {
            expect(scale).toBeGreaterThanOrEqual(0);
            expect(scale).toBeLessThanOrEqual(1);
          }
          expect(sample.opacity).toBeGreaterThan(0);
          expect(sample.opacity).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('clamps a level that arrives out of range rather than propagating it', () => {
    const high = director.sample('amplitude', 0, 4);
    const low = director.sample('amplitude', 0, -1);
    for (const scale of [...high.barScales, ...low.barScales]) {
      expect(scale).toBeGreaterThanOrEqual(0);
      expect(scale).toBeLessThanOrEqual(1);
    }
  });
});

describe('sample — the signatures are actually different', () => {
  it('holds a static signature still', () => {
    expect(director.sample('none', 0, 0.5)).toEqual(director.sample('none', 5_000, 0.5));
  });

  it('moves the amplitude bars with the level, and irregularly', () => {
    const quiet = director.sample('amplitude', 0, 0.1);
    const loud = director.sample('amplitude', 0, 0.9);
    expect(Math.max(...loud.barScales)).toBeGreaterThan(Math.max(...quiet.barScales));

    const sample = director.sample('amplitude', 250, 0.8);
    expect(new Set(sample.barScales).size).toBeGreaterThan(1);
  });

  it('ignores the level while sweeping, because there is no real data', () => {
    expect(director.sample('sweep', 300, 0)).toEqual(director.sample('sweep', 300, 1));
  });

  it('loops the sweep every 1.2 s', () => {
    expect(director.sample('sweep', 100, 0.5)).toEqual(director.sample('sweep', 1_300, 0.5));
  });

  it('travels the sweep left to right', () => {
    const early = director.sample('sweep', 60, 0.5).barScales;
    const late = director.sample('sweep', 1_100, 0.5).barScales;
    expect(argMax(early)).toBeLessThan(argMax(late));
  });

  it('pulses twice on an error and then settles', () => {
    const settled = director.sample('double-pulse-then-static', PULSE_DURATION_MS, 0);
    expect(settled.opacity).toBe(1);
    expect(director.sample('double-pulse-then-static', PULSE_DURATION_MS + 5_000, 0)).toEqual(
      settled,
    );

    const troughs = countTroughs(
      Array.from(
        { length: 64 },
        (_unused, i) =>
          director.sample('double-pulse-then-static', (i * PULSE_DURATION_MS) / 64, 0).opacity,
      ),
    );
    expect(troughs).toBe(2);
  });
});

describe('isStatic and settlesAtMs', () => {
  it('stops the clock on a signature with no animation at all', () => {
    expect(director.isStatic('none')).toBe(true);
    for (const signature of SIGNATURES.filter((s) => s !== 'none')) {
      expect(director.isStatic(signature)).toBe(false);
    }
  });

  it('knows when a settled Error has settled — which isStatic alone cannot say', () => {
    expect(settlesAtMs('none')).toBe(0);
    expect(settlesAtMs('double-pulse-then-static')).toBe(PULSE_DURATION_MS);
    expect(settlesAtMs('amplitude')).toBeNull();
    expect(settlesAtMs('sweep')).toBeNull();
    expect(settlesAtMs('envelope')).toBeNull();
  });
});

function argMax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] ?? 0) > (values[best] ?? 0)) best = i;
  }
  return best;
}

/** A trough is a local minimum strictly below both neighbours — one per pulse boundary. */
function countTroughs(values: readonly number[]): number {
  let count = 0;
  for (let i = 1; i < values.length - 1; i += 1) {
    const previous = values[i - 1] ?? 0;
    const current = values[i] ?? 0;
    const next = values[i + 1] ?? 0;
    if (current < previous && current <= next) count += 1;
  }
  return count;
}

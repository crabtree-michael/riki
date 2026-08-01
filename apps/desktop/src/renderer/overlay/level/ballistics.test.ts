import { describe, expect, it } from 'vitest';

import { ATTACK_MS, RELEASE_MS, createLevelBallistics } from './ballistics.js';

describe('createLevelBallistics — push', () => {
  it('starts at the first value it is given rather than climbing to it', () => {
    const ballistics = createLevelBallistics();
    expect(ballistics.push(0.6, 0)).toBeCloseTo(0.6, 6);
  });

  it('rises faster than it falls', () => {
    const rising = createLevelBallistics();
    rising.push(0, 0);
    const afterAttack = rising.push(1, 100);

    const falling = createLevelBallistics();
    falling.push(1, 0);
    const afterRelease = falling.push(0, 100);

    // Same elapsed time, same distance: the rise should have covered more of it.
    expect(afterAttack).toBeGreaterThan(1 - afterRelease);
  });

  it('reaches roughly 63 % of the step in one time constant', () => {
    const rising = createLevelBallistics();
    rising.push(0, 0);
    expect(rising.push(1, ATTACK_MS)).toBeCloseTo(1 - Math.exp(-1), 2);

    const falling = createLevelBallistics();
    falling.push(1, 0);
    expect(falling.push(0, RELEASE_MS)).toBeCloseTo(Math.exp(-1), 2);
  });

  it('depends on elapsed time, not on how many frames arrived', () => {
    const coarse = createLevelBallistics();
    coarse.push(0, 0);
    const oneStep = coarse.push(1, 200);

    const fine = createLevelBallistics();
    fine.push(0, 0);
    let manySteps = 0;
    for (let t = 10; t <= 200; t += 10) manySteps = fine.push(1, t);

    expect(manySteps).toBeCloseTo(oneStep, 2);
  });

  it('stays inside the unit range whatever it is fed', () => {
    const ballistics = createLevelBallistics();
    ballistics.push(0, 0);
    expect(ballistics.push(5, 100)).toBeLessThanOrEqual(1);
    expect(ballistics.push(-5, 200)).toBeGreaterThanOrEqual(0);
  });

  it('tolerates a frame that arrives out of order without going backwards in time', () => {
    const ballistics = createLevelBallistics();
    ballistics.push(0.5, 100);
    expect(() => ballistics.push(0.5, 50)).not.toThrow();
  });

  it('forgets everything on reset, so a new turn does not inherit the last one', () => {
    const ballistics = createLevelBallistics();
    ballistics.push(1, 0);
    ballistics.reset();
    expect(ballistics.push(0.2, 1_000)).toBeCloseTo(0.2, 6);
  });
});

describe('createLevelBallistics — bars', () => {
  const ballistics = createLevelBallistics();

  it('quantises, so a resting meter does not shimmer', () => {
    for (const height of ballistics.bars(0.4321, 5)) {
      expect(Number.isInteger(height * 16)).toBe(true);
    }
  });

  it('is monotonic in the level, bar for bar', () => {
    let previous = ballistics.bars(0, 5);
    for (let level = 0.05; level <= 1; level += 0.05) {
      const next = ballistics.bars(level, 5);
      next.forEach((height, index) => {
        expect(height).toBeGreaterThanOrEqual(previous[index] ?? 0);
      });
      previous = next;
    }
  });

  it('reads as one meter rather than five — the centre bar is the tallest', () => {
    const heights = ballistics.bars(1, 5);
    expect(heights[2]).toBeGreaterThanOrEqual(heights[0] ?? 0);
    expect(heights[2]).toBeGreaterThanOrEqual(heights[4] ?? 0);
    expect(heights[0]).toBeCloseTo(heights[4] ?? 0, 6);
  });

  it('produces the count it is asked for, including the reduced-motion single bar', () => {
    expect(ballistics.bars(0.5, 5)).toHaveLength(5);
    expect(ballistics.bars(0.5, 1)).toHaveLength(1);
  });

  it('flattens to nothing at silence', () => {
    expect(ballistics.bars(0, 5).every((height) => height === 0)).toBe(true);
  });
});

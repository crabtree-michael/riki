/**
 * The match clock between POSTs.
 *
 * A fact observed at 14:32.4 — a CV frame, a chat line — needs a match clock, and GSI only tells
 * us one 2–8 times a second. So the clock is interpolated from the last real update at 1 s/s.
 *
 * Two rules, and the second is the one that gets broken:
 *
 * 1. **Frozen while paused.** `map.clock_time` does not advance during a pause and neither does
 *    this, which is what makes the game-time ageing basis correct through one.
 * 2. **Corrected, never smoothed.** When a real update disagrees with the estimate, the estimate
 *    loses immediately. Smoothing would hide a reconnect — the exact event that has to be
 *    detected — behind a gradual convergence that looks like normal drift.
 *
 * And the rule from the `game-state` skill that this class exists to make unnecessary elsewhere:
 * **never infer elapsed time from update count.** The rate is 2–8 Hz, irregular, and varies with
 * client load. It is not a clock.
 */

import type { GameClock, GameClockEstimator, MonoMs } from './contracts.js';

/**
 * A jump larger than this between the estimate and a real update is a discontinuity — a
 * reconnect, or a new match on the same id — rather than drift. §6.4 turns it into a resync.
 */
export const DISCONTINUITY_THRESHOLD_SECONDS = 5;

export function createGameClockEstimator(): GameClockEstimator {
  let anchorClock: GameClock | null = null;
  let anchorAt: MonoMs = 0 as MonoMs;
  let paused = false;

  return {
    update(clock: GameClock, at: MonoMs, isPaused: boolean): void {
      anchorClock = clock;
      anchorAt = at;
      paused = isPaused;
    },

    estimate(now: MonoMs): GameClock | null {
      // Null before the first update, and that is not the same as clock zero: pre-horn and
      // loading genuinely have no clock, and answering 0 would date every fact to the horn.
      if (anchorClock === null) return null;
      if (paused) return anchorClock;
      return (anchorClock + Math.max(0, now - anchorAt) / 1000) as GameClock;
    },
  };
}

/**
 * How far a real update is from what was estimated, in seconds. Positive means the match clock
 * jumped forward. Zero when there is nothing to compare against yet.
 */
export function clockDrift(estimator: GameClockEstimator, actual: GameClock, now: MonoMs): number {
  const estimated = estimator.estimate(now);
  return estimated === null ? 0 : actual - estimated;
}

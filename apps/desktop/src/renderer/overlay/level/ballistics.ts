/**
 * Level ballistics — how a 30 Hz meter is made readable.
 *
 * The boundary with @riki/audio is worth restating because it looks arbitrary: **audio owns the
 * signal, the renderer owns the ballistics.** RMS and the TTS output envelope are audio maths and
 * are unit-tested against known PCM. Attack/decay smoothing and quantisation to five bars are
 * *display* decisions — they exist to make a meter legible and they change no audio behaviour
 * (docs/design/overlay-architecture.md §7.4).
 */

import type { Millis } from '../../../shared/overlay.js';
import type { LevelBallistics } from '../contracts.js';

/**
 * Attack and release differ because they model different things: a meter has to rise fast enough
 * to catch a consonant and fall slowly enough to be readable at a glance from the edge of vision.
 */
export const ATTACK_MS = 40;
export const RELEASE_MS = 220;

/** Quantisation step. Fine enough to look continuous, coarse enough not to shimmer at rest. */
const STEPS = 16;

export interface BallisticsOptions {
  readonly attackMs?: Millis;
  readonly releaseMs?: Millis;
}

export function createLevelBallistics(options: BallisticsOptions = {}): LevelBallistics {
  const attackMs = options.attackMs ?? ATTACK_MS;
  const releaseMs = options.releaseMs ?? RELEASE_MS;

  let current = 0;
  let lastAt: Millis | null = null;

  return {
    push(value, now) {
      const target = clamp(value, 0, 1);

      if (lastAt === null) {
        lastAt = now;
        current = target;
        return current;
      }

      const dt = Math.max(now - lastAt, 0);
      lastAt = now;

      // One-pole, expressed against elapsed time rather than a frame count: frames are dropped
      // and coalesced upstream, so a per-frame coefficient would make the meter's speed depend on
      // how busy the machine is.
      const tau = target > current ? attackMs : releaseMs;
      const coefficient = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      current = clamp(current + (target - current) * coefficient, 0, 1);
      return current;
    },

    bars(level, count) {
      const clamped = clamp(level, 0, 1);
      const centre = (count - 1) / 2;

      return Array.from({ length: count }, (_unused, index) => {
        // Centre-weighted, so five bars read as one meter rather than five independent ones.
        const shape = 1 - (0.3 * Math.abs(index - centre)) / Math.max(centre, 1);
        return Math.round(clamped * shape * STEPS) / STEPS;
      });
    },

    reset() {
      current = 0;
      lastAt = null;
    },
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

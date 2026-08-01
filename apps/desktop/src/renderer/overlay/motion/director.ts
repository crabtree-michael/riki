/**
 * Motion signatures — pure, deterministic, and the second of the two channels that make every
 * state readable without colour vision (ui-design.md §4.3).
 *
 * `sample` is a total function of (signature, t, level): same inputs, same output, no clock read
 * and no state. That is what lets ui-design.md §10's "composite-only animation" be a Tier 1 test
 * rather than something only observable by watching the chip
 * (docs/design/overlay-architecture.md §7.3).
 */

import type { ChipState, Millis, MotionSignature } from '../../../shared/overlay.js';
import type { MotionDirector, MotionPreferences, MotionSample } from '../contracts.js';

/**
 * ui-design.md §4.3. The same table as `machine.ts`'s `MOTIONS`, on the renderer side.
 *
 * Every live state now has a signature no other live state shares except the three that hold still
 * — Acting was the one that duplicated Processing's sweep, and ADR-0023 deleted it.
 */
const SIGNATURES: Readonly<Record<ChipState, MotionSignature>> = {
  hidden: 'none',
  armed: 'none',
  listening: 'amplitude',
  processing: 'sweep',
  speaking: 'envelope',
  error: 'double-pulse-then-static',
  muted: 'none',
};

/** ui-design.md §5.1: the sweep is a 1.2 s loop. */
const SWEEP_PERIOD_MS = 1_200;

/** One double-pulse, then static (ui-design.md §3, §4.3). */
export const PULSE_DURATION_MS: Millis = 620;

/** Per-bar periods, deliberately non-harmonic so the amplitude motion reads as irregular. */
const BAR_PERIODS_MS = [383, 291, 467, 331, 409];

const MIN_SCALE = 0.08;

/**
 * How long after entering a state its motion settles, or `null` if it never does.
 *
 * `isStatic` answers "does this signature animate at all", which is not quite the question the
 * animation clock needs: a *settled* Error has no animation but a freshly entered one does
 * (§7.3). The clock stops at this time rather than rendering identical frames forever.
 */
export function settlesAtMs(signature: MotionSignature): Millis | null {
  if (signature === 'none') return 0;
  if (signature === 'double-pulse-then-static') return PULSE_DURATION_MS;
  return null;
}

export function createMotionDirector(barCount = 5): MotionDirector {
  return {
    signatureFor(state: ChipState, prefs: MotionPreferences): MotionSignature {
      const signature = SIGNATURES[state];
      if (!prefs.reducedMotion) return signature;
      // Reduced motion is a variant of every state, not a global off switch. The looping
      // signatures go static — the amplitude bars carry real information, so they become a single
      // static filled bar rather than disappearing (ui-design.md §9.1). The double-pulse stays:
      // §9.1 asks for looping animation to be replaced *by* static opacity steps, and that is
      // exactly what it already is.
      return signature === 'double-pulse-then-static' ? signature : 'none';
    },

    isStatic(signature: MotionSignature): boolean {
      return signature === 'none';
    },

    sample(signature: MotionSignature, tMs: Millis, level: number): MotionSample {
      const clamped = clamp(level, 0, 1);

      switch (signature) {
        case 'none':
          // One bar, filled to the level: still information, with no motion of its own.
          return { barScales: [clamp(clamped, MIN_SCALE, 1)], opacity: 1, glyphScale: 1 };

        case 'amplitude':
          return {
            barScales: bars(barCount, (index) => {
              const period = BAR_PERIODS_MS[index % BAR_PERIODS_MS.length] ?? 400;
              const wobble = 0.55 + 0.45 * Math.sin((2 * Math.PI * tMs) / period);
              return clamp(clamped * wobble, MIN_SCALE, 1);
            }),
            opacity: 1,
            glyphScale: 1,
          };

        case 'envelope':
          // Slower and centre-weighted, so Riki speaking never looks like Riki listening.
          return {
            barScales: bars(barCount, (index) => {
              const centre = (barCount - 1) / 2;
              const shape = 1 - (0.35 * Math.abs(index - centre)) / Math.max(centre, 1);
              const breath = 0.7 + 0.3 * Math.sin((2 * Math.PI * tMs) / 700 + index * 0.4);
              return clamp(clamped * shape * breath, MIN_SCALE, 1);
            }),
            opacity: 1,
            glyphScale: 1,
          };

        case 'sweep': {
          // Indeterminate: no real data, so the level is ignored entirely.
          const progress = (tMs % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS;
          const head = progress * (barCount + 1) - 1;
          return {
            barScales: bars(barCount, (index) => {
              const distance = index - head;
              return clamp(0.2 + 0.8 * Math.exp(-(distance * distance) / 0.9), MIN_SCALE, 1);
            }),
            opacity: 1,
            glyphScale: 1,
          };
        }

        case 'double-pulse-then-static': {
          const pulse = doublePulse(tMs);
          return {
            barScales: bars(barCount, () => MIN_SCALE),
            opacity: 0.55 + 0.45 * pulse,
            glyphScale: 1 + 0.12 * pulse,
          };
        }
      }
    },
  };
}

/** Two 150 ms pulses with a 110 ms gap, then flat. */
function doublePulse(tMs: Millis): number {
  if (tMs >= PULSE_DURATION_MS) return 1;
  const first = hump(tMs, 0, 150);
  const second = hump(tMs, 260, 150);
  return Math.max(first, second);
}

function hump(tMs: Millis, startMs: Millis, widthMs: Millis): number {
  const local = (tMs - startMs) / widthMs;
  if (local < 0 || local > 1) return 0;
  return Math.sin(Math.PI * local);
}

function bars(count: number, height: (index: number) => number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => height(index));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The CV drift monitor — the one place CV output touches `self.*`, and it does not write.
 *
 * CV reads the player's own HUD, where GSI already gives ground truth, so disagreement is a free
 * and continuous calibration check. `broken` is the detector behind two rows of dota2 §9's failure
 * table — *CV confidence collapse* and *resolution / HUD scale change* — and getting that signal
 * for nothing is the reason to keep reading a region we otherwise have no need for.
 *
 * See docs/design/state-capture-architecture.md §5.6.
 */

import type { MonoMs } from './time.js';

export interface CvDriftStatus {
  /** Rolling agreement over the window, 0–1. */
  readonly agreement: number;
  readonly verdict: 'ok' | 'suspect' | 'broken';
  readonly samples: number;
}

export interface CvDriftMonitor {
  observe(cvValue: number, gsiValue: number, at: MonoMs): void;
  status(now: MonoMs): CvDriftStatus;
}

export interface CvDriftOptions {
  readonly windowMs: number;
  readonly suspectBelow: number;
  readonly brokenBelow: number;
}

export const DEFAULT_DRIFT_OPTIONS: CvDriftOptions = {
  windowMs: 30_000,
  suspectBelow: 0.9,
  brokenBelow: 0.6,
};

/**
 * A sample is a plain agreement bit — did CV read the same number GSI did — with a small relative
 * tolerance, because the two are sampled at different instants and a health bar that moved between
 * them is not a calibration failure.
 */
const RELATIVE_TOLERANCE = 0.02;
const ABSOLUTE_TOLERANCE = 1;

/** Below this many samples the verdict is `ok`: three disagreements are not a trend. */
export const MIN_SAMPLES = 8;

interface Sample {
  readonly at: MonoMs;
  readonly agreed: boolean;
}

export function createCvDriftMonitor(opts: CvDriftOptions = DEFAULT_DRIFT_OPTIONS): CvDriftMonitor {
  let samples: Sample[] = [];

  const prune = (now: MonoMs): void => {
    const cutoff = now - opts.windowMs;
    if (samples.length > 0 && (samples[0]?.at ?? cutoff) < cutoff) {
      samples = samples.filter((sample) => sample.at >= cutoff);
    }
  };

  return {
    observe(cvValue: number, gsiValue: number, at: MonoMs): void {
      const tolerance = Math.max(ABSOLUTE_TOLERANCE, Math.abs(gsiValue) * RELATIVE_TOLERANCE);
      samples.push({ at, agreed: Math.abs(cvValue - gsiValue) <= tolerance });
      prune(at);
    },

    status(now: MonoMs): CvDriftStatus {
      prune(now);
      const total = samples.length;
      if (total === 0) return { agreement: 1, verdict: 'ok', samples: 0 };

      const agreement = samples.filter((sample) => sample.agreed).length / total;
      // Too few samples is not evidence of health, but it is not evidence of drift either, and
      // suppressing every CV fact on the strength of four disagreements would make a brief
      // occlusion look like a broken calibration.
      if (total < MIN_SAMPLES) return { agreement, verdict: 'ok', samples: total };

      const verdict =
        agreement < opts.brokenBelow ? 'broken' : agreement < opts.suspectBelow ? 'suspect' : 'ok';
      return { agreement, verdict, samples: total };
    },
  };
}

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

export declare function createCvDriftMonitor(opts: CvDriftOptions): CvDriftMonitor;

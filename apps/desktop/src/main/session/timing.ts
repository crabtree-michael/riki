/**
 * The numbers from ui-design.md §8, in one place.
 *
 * The two that are user-configurable — the silence nudge and the listening timeout — are
 * deliberately *not* here: they live on `MachineEnvironment` because ui-design.md §9.1 calls the
 * defaults hostile for people who speak slowly, and a constant cannot be a setting.
 */

import type { Millis } from '../../shared/overlay.js';
import type { MachineEnvironment } from './types.js';

/** Processing → show an elapsed counter. Turns "hung" into "working". */
export const ELAPSED_HINT_MS: Millis = 2_500;

/** Processing → surface `Esc ✕`. An escape hatch before the user kills the app. */
export const CANCEL_HINT_MS: Millis = 10_000;

/** Error → auto-dismiss. Persistent faults ignore this and stay until resolved. */
export const ERROR_DISMISS_MS: Millis = 4_000;

/**
 * Hold before the window is unmapped, covering the renderer's 200 ms fade-out and preventing
 * strobing on rapid interactions. It travels on the `window` effect rather than being a timer the
 * machine schedules — the window controller owns it, because it is also what a `showFast()`
 * arriving mid-hold has to cancel.
 */
export const HIDE_HOLD_MS: Millis = 400;

/**
 * How long a freshly entered phase reports itself as `entering`. Matches the 80 ms fade-in, so the
 * renderer gets one model saying "animate in" and every later model for that phase says "settled".
 */
export const ENTER_MS: Millis = 80;

/** ui-design.md §8 and §9.1, as the defaults the settings layer starts from. */
export const DEFAULT_ENVIRONMENT: MachineEnvironment = {
  silenceNudgeMs: 1_200,
  listenTimeoutMs: 8_000,
  holdThresholdMs: 250,
  captionsEnabled: false,
  earconsEnabled: true,
  duckingEnabled: true,
};

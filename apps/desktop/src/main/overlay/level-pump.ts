/**
 * The level pump — 30 Hz, and only while the bars can be seen.
 *
 * Driven by the machine's `levels` effect, never by the view. Rate limiting lives here, upstream
 * of the renderer, so a bug in the chip's drawing code cannot turn into 144 IPC messages a second
 * (docs/design/overlay-architecture.md §5.5). ui-design.md §10 asks for 30 fps rather than the
 * game's refresh rate; this is where that is enforced.
 */

import type { LevelFrame, LevelSource, Millis } from '../../shared/overlay.js';
import type { LevelPump } from './contracts.js';

/** ~30 Hz. The bars carry nothing that needs 144 Hz. */
export const FRAME_INTERVAL_MS: Millis = 33;

export interface LevelPumpDeps {
  readonly now: () => Millis;
  readonly send: (frame: LevelFrame) => void;
  readonly intervalMs?: Millis;
}

export function createLevelPump(deps: LevelPumpDeps): LevelPump {
  const interval = deps.intervalMs ?? FRAME_INTERVAL_MS;

  let source: LevelSource | null = null;
  let lastSentAt: Millis | null = null;

  return {
    start(next) {
      source = next;
      // Cleared, not preserved: the first frame of a new source must move the bars immediately,
      // or barge-in spends its 250 ms budget waiting out the previous turn's throttle.
      lastSentAt = null;
    },

    stop() {
      source = null;
      lastSentAt = null;
    },

    isRunning() {
      return source !== null;
    },

    onFrame(frame) {
      // A frame for the source we are no longer showing is not late, it is wrong: output levels
      // arriving after barge-in would drive the input meter.
      if (source === null || frame.source !== source) return;

      const now = deps.now();
      if (lastSentAt !== null && now - lastSentAt < interval) return;

      lastSentAt = now;
      deps.send(frame);
    },
  };
}

/**
 * The animation clock: 30 fps, and stopped whenever the state is static.
 *
 * ui-design.md §10 asks for 30 fps rather than the game's refresh rate — the bars carry nothing
 * that needs 144 Hz — and for the timer to *stop* on a static state rather than render identical
 * frames. `framesRendered` exists so the second half of that is assertable: the Tier 5 idle test
 * reads it (docs/design/overlay-architecture.md §10.4).
 *
 * `requestFrame` is injected rather than reached for, so the whole thing is testable with no
 * browser.
 */

import type { Millis, Unsubscribe } from '../../../shared/overlay.js';
import type { AnimationClock } from '../contracts.js';

/** ~30 fps. */
export const FRAME_INTERVAL_MS: Millis = 33;

export interface AnimationClockDeps {
  readonly requestFrame: (fn: (timestamp: Millis) => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly intervalMs?: Millis;
}

export function createAnimationClock(deps: AnimationClockDeps): AnimationClock {
  const interval = deps.intervalMs ?? FRAME_INTERVAL_MS;
  const subscribers = new Set<(tMs: Millis) => void>();

  let handle: number | null = null;
  let startedAt: Millis | null = null;
  let lastTickAt: Millis | null = null;
  let frames = 0;

  function pump(timestamp: Millis): void {
    handle = deps.requestFrame(pump);
    startedAt ??= timestamp;

    // The host may call back at 144 Hz. Everything above 30 is dropped here, before it reaches a
    // view — so a bug in the chip cannot turn into per-frame layout at the game's refresh rate.
    if (lastTickAt !== null && timestamp - lastTickAt < interval) return;
    lastTickAt = timestamp;
    frames += 1;

    const elapsed = timestamp - startedAt;
    for (const subscriber of [...subscribers]) subscriber(elapsed);
  }

  return {
    start() {
      if (handle !== null) return;
      startedAt = null;
      lastTickAt = null;
      handle = deps.requestFrame(pump);
    },

    stop() {
      if (handle === null) return;
      deps.cancelFrame(handle);
      handle = null;
      startedAt = null;
      lastTickAt = null;
    },

    isRunning() {
      return handle !== null;
    },

    subscribe(fn): Unsubscribe {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    framesRendered() {
      return frames;
    },
  };
}

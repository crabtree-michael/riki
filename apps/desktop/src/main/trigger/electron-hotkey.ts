/**
 * The only file in the trigger component that imports Electron.
 *
 * `globalShortcut` is a key-*down* API. There is no `globalShortcut.registerUp`, no key-up event
 * on the accelerator, and no supported way to ask Electron for one — which is exactly the
 * limitation ui-design.md §6.4 opens with, and the reason this file cannot deliver push-to-talk.
 *
 * What it does instead is the honest degradation: each press is reported as a key-down
 * **immediately followed by a key-up at the same instant**, which the recognizer reads as a tap
 * and turns into a latched capture. A player gets tap-to-latch — press to start, press again to
 * stop — everywhere Electron can register the accelerator at all, and `hasKeyUp` is `false` so the
 * shell can say so rather than leaving them to discover that holding the key does nothing.
 *
 * Registering `Esc` globally is deliberately **not** done: it would swallow the key for every
 * other application on the machine, including the game. Cancel therefore arrives from the overlay
 * renderer's `cancel` intent instead (overlay-architecture.md §6.1), and `onCancel` here exists so
 * the shell has one place to wire it when a real event tap lands and `Esc` can be observed without
 * being consumed.
 */

import { globalShortcut } from 'electron';
import type { Millis, Unsubscribe } from '../../shared/overlay.js';
import type { KeySource } from './index.js';

/** ui-design.md §6.3. Games rarely bind `Ctrl` chords, and backtick is usually a console key. */
export const DEFAULT_TALK_ACCELERATOR = 'Control+`';

/** Declared for completeness; see the header for why it is not registered globally. */
export const DEFAULT_CANCEL_ACCELERATOR = 'Escape';

export interface ElectronKeySourceOptions {
  readonly accelerator?: string;
  readonly now: () => Millis;
}

export function createElectronKeySource(options: ElectronKeySourceOptions): KeySource {
  const accelerator = options.accelerator ?? DEFAULT_TALK_ACCELERATOR;
  const downListeners = new Set<(now: Millis) => void>();
  const upListeners = new Set<(now: Millis) => void>();
  const cancelListeners = new Set<() => void>();
  let bound = false;

  return {
    // A press is one instant, reported as both edges. The recognizer's threshold comparison is
    // `now - downAt < threshold`, so a zero-length hold is unambiguously a tap.
    hasKeyUp: false,

    bind(): boolean {
      if (bound) return true;
      // `isRegistered` first: `register` returning false is also how "another app owns this
      // accelerator" surfaces, and the two need different messages to the user (§6.3).
      if (globalShortcut.isRegistered(accelerator)) return false;

      bound = globalShortcut.register(accelerator, () => {
        const now = options.now();
        for (const listener of [...downListeners]) listener(now);
        for (const listener of [...upListeners]) listener(now);
      });
      return bound;
    },

    unbind(): void {
      if (!bound) return;
      bound = false;
      globalShortcut.unregister(accelerator);
    },

    onKeyDown(listener): Unsubscribe {
      downListeners.add(listener);
      return () => downListeners.delete(listener);
    },

    onKeyUp(listener): Unsubscribe {
      upListeners.add(listener);
      return () => upListeners.delete(listener);
    },

    onCancel(listener): Unsubscribe {
      cancelListeners.add(listener);
      return () => cancelListeners.delete(listener);
    },
  };
}

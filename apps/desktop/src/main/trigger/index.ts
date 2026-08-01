/**
 * The hotkey layer: a key source, the pure gesture recognizer, and the pump that joins them.
 *
 * ## The platform problem, stated once
 *
 * ui-design.md §6.4 calls this "the highest-risk implementation area", and the specific reason is
 * in its first line: **push-to-talk needs both key edges, and Electron's `globalShortcut` fires on
 * key-down only.** There is no supported way to see a key-up from `globalShortcut`, so the
 * cross-platform API Electron hands us cannot open a mic and close it again. Every platform needs
 * something lower — a `CGEventTap` on macOS (gated on Accessibility, and the headline risk on the
 * primary platform), `XGrabKey` or evdev on X11, the `GlobalShortcuts` portal on Wayland,
 * `WH_KEYBOARD_LL` on Windows — and none of those is reachable without a native module.
 *
 * So `KeySource` is the seam, and `electron-hotkey.ts` is the implementation that exists today: it
 * synthesises a down-and-up pair from each `globalShortcut` press, which the recognizer reads as a
 * tap. **Tap-to-latch works; hold-to-push does not.** That is a real product gap, it is the
 * shape §6.4 predicted, and it is confined to one file behind one interface — which is the whole
 * reason the interface is here.
 *
 * The anti-cheat spike (REPO_SKELETON.md §11.6, `docs/runbooks/anticheat-validation.md`) is the
 * other thing standing in front of the native path, and it is still unrun. A global keyboard hook
 * is the shape anti-cheat systems flag (§13.3), so the event tap is not merely unwritten — it is
 * unwritten *on purpose* until somebody has confirmed it does not get the player banned.
 */

import type { Millis, Unsubscribe } from '../../shared/overlay.js';
import type { TriggerEvent } from '../session/types.js';
import type { GestureRecognizer } from './contracts.js';

export * from './contracts.js';
export { createGestureRecognizer, HOLD_THRESHOLD_MS } from './recognizer.js';
export type { GestureRecognizerOptions } from './recognizer.js';
export {
  createElectronKeySource,
  DEFAULT_TALK_ACCELERATOR,
  DEFAULT_CANCEL_ACCELERATOR,
} from './electron-hotkey.js';
export type { ElectronKeySourceOptions } from './electron-hotkey.js';

/**
 * Raw key edges from the OS, before any gesture interpretation.
 *
 * `bind` returns `false` rather than throwing when the accelerator is taken: a hotkey conflict is
 * an ordinary condition on a machine with other software on it, and ui-design.md §6.3 wants it
 * surfaced to the user at bind time rather than crashed on.
 */
export interface KeySource {
  bind(): boolean;
  unbind(): void;
  onKeyDown(listener: (now: Millis) => void): Unsubscribe;
  onKeyUp(listener: (now: Millis) => void): Unsubscribe;
  /** `Esc`. Not a gesture — it ends things rather than starting them (machine.ts's `cancel`). */
  onCancel(listener: () => void): Unsubscribe;
  /** Whether both edges are real. `false` means push-to-talk is unavailable — see the header. */
  readonly hasKeyUp: boolean;
}

export interface TriggerPumpDeps {
  readonly keys: KeySource;
  readonly recognizer: GestureRecognizer;
  readonly now: () => Millis;
  /** Schedules the hold-threshold tick. Injected so the 250 ms edge is testable. */
  readonly after: (ms: number, fn: () => void) => () => void;
  readonly dispatch: (event: TriggerEvent) => void;
  readonly holdThresholdMs?: Millis;
}

export interface TriggerPump {
  start(): boolean;
  stop(): void;
  /** The machine returned to Idle by some path that was not a key. See `recognizer.ts`'s header. */
  resync(): void;
}

/**
 * Joins the two, and owns the one timer in the component.
 *
 * The tick is scheduled on key-down and cancelled on key-up, rather than run free: a recognizer
 * polled on an interval would decide the gesture up to one interval late, and 250 ms is short
 * enough that "up to one interval late" is the difference between a tap and a hold.
 */
export function createTriggerPump(deps: TriggerPumpDeps): TriggerPump {
  const holdThresholdMs = deps.holdThresholdMs ?? 250;
  let cancelTick: (() => void) | null = null;
  const subscriptions: Unsubscribe[] = [];

  function emit(events: readonly TriggerEvent[]): void {
    for (const event of events) deps.dispatch(event);
  }

  function clearTick(): void {
    cancelTick?.();
    cancelTick = null;
  }

  return {
    start(): boolean {
      subscriptions.push(
        deps.keys.onKeyDown((now) => {
          emit(deps.recognizer.keyDown(now));
          clearTick();
          cancelTick = deps.after(holdThresholdMs, () => {
            cancelTick = null;
            emit(deps.recognizer.tick(deps.now()));
          });
        }),
        deps.keys.onKeyUp((now) => {
          clearTick();
          emit(deps.recognizer.keyUp(now));
        }),
        deps.keys.onCancel(() => {
          clearTick();
          deps.recognizer.reset();
          deps.dispatch({ kind: 'cancel' });
        }),
      );
      return deps.keys.bind();
    },

    stop(): void {
      clearTick();
      for (const stop of subscriptions) stop();
      subscriptions.length = 0;
      deps.keys.unbind();
      deps.recognizer.reset();
    },

    resync(): void {
      clearTick();
      deps.recognizer.reset();
    },
  };
}

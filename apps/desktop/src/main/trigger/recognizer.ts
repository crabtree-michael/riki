/**
 * The tap/hold gesture — ui-design.md §6.2.
 *
 * One key, two behaviours, disambiguated by a 250 ms threshold: a release before the threshold
 * **latches** (capture until the key is tapped again), a hold past it is **push** (capture until
 * release). The threshold is tuned so a deliberate tap always latches and a natural "hold and
 * speak" never latches by accident.
 *
 * Pure, and driven entirely by `now`: the whole point of the seam in `contracts.ts` is that
 * testing 250 ms should not require a keyboard.
 *
 * ## Two things this file cannot hide
 *
 * **A held key's chip cannot appear before the threshold.** `main/session/machine.ts` decides
 * push-versus-latch from the *first* trigger event of a gesture — `tap` begins a latched capture,
 * `down` begins a push — and its state table has no edge that promotes one into the other
 * (`endsGesture` is the whole rule). So the recognizer cannot emit `down` optimistically at
 * key-down and correct itself 250 ms later; it has to wait until it knows.
 *
 * That puts overlay-architecture.md §9.1's "t+0 key-down → visible" budget on the wrong side of
 * §6.2's threshold: the chip appears ≤100 ms after the *decision*, which is ≤100 ms after key-down
 * for a tap and ≤350 ms after it for a hold. Neither document acknowledges the interaction. It is
 * named here rather than quietly resolved, because resolving it means either giving up
 * tap-to-latch or adding a promote edge to a state table this file does not own.
 *
 * **The recognizer is not the authority on whether a capture is open.** A latched session also
 * ends on silence, on `Esc`, and on a fault, and none of those touch a key. So the recognizer
 * tracks the latch only to know what its own next gesture means, and the shell calls `reset()`
 * whenever the machine returns to Idle. That subscription is the synchronisation point; without
 * it the two drift apart after the first non-key ending, and the drift shows up as one swallowed
 * key press some minutes later.
 */

import type { Millis } from '../../shared/overlay.js';
import type { TriggerEvent } from '../session/types.js';
import type { GestureRecognizer } from './contracts.js';

/** ui-design.md §6.2. A deliberate tap always latches; a natural hold never latches by accident. */
export const HOLD_THRESHOLD_MS = 250;

const DOWN: readonly TriggerEvent[] = [{ kind: 'down' }];
const UP: readonly TriggerEvent[] = [{ kind: 'up' }];
const DOWN_THEN_UP: readonly TriggerEvent[] = [{ kind: 'down' }, { kind: 'up' }];
const TAP: readonly TriggerEvent[] = [{ kind: 'tap' }];
const NONE: readonly TriggerEvent[] = [];

type Phase =
  | { readonly kind: 'idle' }
  /** Key is down and the threshold has not passed. Which gesture this is, is not yet known. */
  | { readonly kind: 'deciding'; readonly downAt: Millis }
  /** `down` emitted; the release will end it. */
  | { readonly kind: 'pushing' }
  /** `tap` emitted; the *next* tap ends it, which is what "latch" means. */
  | { readonly kind: 'latched' };

export interface GestureRecognizerOptions {
  /** Injected from settings — `MachineEnvironment.holdThresholdMs` is the same number. */
  readonly holdThresholdMs?: Millis;
}

export function createGestureRecognizer(options: GestureRecognizerOptions = {}): GestureRecognizer {
  const threshold = options.holdThresholdMs ?? HOLD_THRESHOLD_MS;
  let phase: Phase = { kind: 'idle' };

  return {
    keyDown(now: Millis): readonly TriggerEvent[] {
      switch (phase.kind) {
        case 'idle':
        case 'latched':
          // Both start the same way, and deliberately: `tap` is what begins a latch *and* what
          // ends one, so the recognizer does not need to know which of the two this will be.
          phase = { kind: 'deciding', downAt: now };
          return NONE;

        case 'deciding':
        case 'pushing':
          // Key repeat, or a second physical key bound to the same accelerator. Neither is a new
          // gesture, and neither may restart the threshold — that would make a held key
          // undecidable for as long as the OS keeps repeating it.
          return NONE;
      }
    },

    keyUp(now: Millis): readonly TriggerEvent[] {
      switch (phase.kind) {
        case 'deciding':
          if (now - phase.downAt < threshold) {
            phase = { kind: 'latched' };
            return TAP;
          }
          // Held past the threshold with no `tick` in between — a coarse timer, or a caller that
          // only ticks while idle. It is still a push and it is already over, so both edges go at
          // once rather than the release being dropped for want of an opening.
          phase = { kind: 'idle' };
          return DOWN_THEN_UP;

        case 'pushing':
          phase = { kind: 'idle' };
          return UP;

        case 'latched':
        case 'idle':
          // The release of the press that latched, reported by a caller that sends both edges, or
          // a stray up with no down. Neither is a gesture.
          return NONE;
      }
    },

    tick(now: Millis): readonly TriggerEvent[] {
      if (phase.kind !== 'deciding') return NONE;
      if (now - phase.downAt < threshold) return NONE;
      phase = { kind: 'pushing' };
      return DOWN;
    },

    reset(): void {
      phase = { kind: 'idle' };
    },
  };
}

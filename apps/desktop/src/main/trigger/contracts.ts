/**
 * The seam between the hotkey layer and the interaction machine.
 *
 * The hotkey layer itself — binding, platform capture, conflict detection at bind time
 * (ui-design.md §6.3–§6.4) — is a sibling task that owns this directory. The overlay depends on
 * exactly two things from it: that it produces `TriggerEvent`s, and that the tap-versus-hold
 * decision is pure, because the 250 ms threshold in ui-design.md §6.2 is a number that needs a
 * test and testing it should not require a keyboard.
 *
 * Declarations only. See docs/design/overlay-architecture.md §5.7.
 */

import type { Millis } from '../../shared/overlay.js';
import type { TriggerEvent } from '../session/types.js';

export interface GestureRecognizer {
  keyDown(now: Millis): readonly TriggerEvent[];
  keyUp(now: Millis): readonly TriggerEvent[];
  /** The hold threshold expiring, or a latched capture timing out. */
  tick(now: Millis): readonly TriggerEvent[];
  reset(): void;
}

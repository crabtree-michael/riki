/**
 * The chip's text: a fault while Error, and the elapsed counter while Processing.
 *
 * Text is a last resort (ui-design.md §1.5) — reading costs foveal attention — so this slot is
 * empty most of the time and collapses when it is. It is emptier than it was: the Acting verb and
 * the Confirming question were two of its four callers, and ADR-0023 deleted both. Nothing here is
 * a control either: the window is click-through, so `Fix ▸` is a hint rendered as text (§1.1).
 */

import type { ChipText } from '../../../shared/overlay.js';
import type { TextSlot } from '../contracts.js';

export interface TextSlotElements {
  readonly root: HTMLElement;
  readonly primary: HTMLElement;
  readonly elapsed: HTMLElement;
  readonly hint: HTMLElement;
}

export function createTextSlot(elements: TextSlotElements): TextSlot {
  const { root, primary, elapsed, hint } = elements;

  return {
    set(text: ChipText | null) {
      if (text === null) {
        root.hidden = true;
        primary.textContent = '';
        hint.textContent = '';
        elapsed.textContent = '';
        elapsed.hidden = true;
        return;
      }

      root.hidden = false;
      primary.textContent = text.primary;
      primary.hidden = text.primary === '';
      hint.textContent = text.hint ?? '';
      hint.hidden = text.hint === undefined;

      if (text.elapsedMs === undefined) {
        elapsed.textContent = '';
        elapsed.hidden = true;
        return;
      }
      elapsed.hidden = false;
      this.tickElapsed(Math.round(text.elapsedMs / 1_000));
    },

    tickElapsed(seconds: number) {
      // Once a second, from the app's frame loop — not re-shaped every frame (§7.2).
      const next = `${String(Math.max(seconds, 0))}s`;
      if (elapsed.textContent !== next) elapsed.textContent = next;
    },
  };
}

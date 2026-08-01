/**
 * Caption mode — off by default, and it never auto-enables.
 *
 * A transcript overlay on a live stream is a privacy incident waiting to happen (ui-design.md
 * §9.3), so the default is asserted by test and the panel renders nothing at all until it is given
 * content. It expands the chip downward and never covers screen centre (§5.4).
 *
 * The panel renders whatever text it is handed. *Who scrubs other players' chat before it becomes
 * a caption* is a packages/context question and is still open (§14) — the overlay is only where
 * the leak would be visible.
 */

import type { CaptionModel } from '../../../shared/overlay.js';
import type { CaptionPanel } from '../contracts.js';

export interface CaptionElements {
  readonly root: HTMLElement;
  readonly you: HTMLElement;
  readonly riki: HTMLElement;
}

export function createCaptionPanel(elements: CaptionElements): CaptionPanel {
  const { root, you, riki } = elements;

  return {
    set(captions: CaptionModel | null) {
      const hasText =
        captions !== null && ((captions.you ?? '') !== '' || (captions.riki ?? '') !== '');
      root.hidden = !hasText;
      if (!hasText) {
        you.textContent = '';
        riki.textContent = '';
        return;
      }

      you.textContent = captions.you ?? '';
      you.hidden = (captions.you ?? '') === '';
      riki.textContent = captions.riki ?? '';
      riki.hidden = (captions.riki ?? '') === '';
    },
  };
}

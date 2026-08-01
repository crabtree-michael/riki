/**
 * The status glyph — the channel that works with no colour vision at all (ui-design.md §4.3).
 *
 * The shapes are drawn in CSS off `data-glyph`, so this view writes an attribute and a token name
 * and nothing else. That keeps every colour value in tokens.css and makes the glyph assertable
 * without rendering anything.
 */

import type { AccentToken, GlyphId } from '../../../shared/overlay.js';
import type { GlyphView } from '../contracts.js';
import { cssVariable } from '../tokens/index.js';

export function createGlyphView(element: HTMLElement): GlyphView {
  return {
    set(glyph: GlyphId, accent: AccentToken) {
      element.dataset.glyph = glyph;
      element.dataset.accent = accent;
      element.style.setProperty('--riki-accent', `var(${cssVariable(accent)})`);
    },
  };
}

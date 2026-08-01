/**
 * The chip: one rounded, translucent, dark surface with a hairline border, holding a glyph, five
 * bars, a text slot and an optional caption panel (ui-design.md §4.1, §5.1).
 *
 * The `update` / `frame` split is the whole of ui-design.md §10's "composite-only animation".
 * `update` runs a handful of times per turn and may reflow — the 160 ms width animation happens
 * there, in CSS. `frame` runs at 30 Hz and writes `transform` and `opacity` only.
 */

import type { ChipViewModel, OverlayEnvironment } from '../../../shared/overlay.js';
import type { ChipView, MotionSample } from '../contracts.js';
import { cssVariable } from '../tokens/index.js';
import { createBarsView } from './bars.js';
import { createCaptionPanel } from './caption-panel.js';
import { createGlyphView } from './glyph.js';
import { createTextSlot } from './text-slot.js';

export function createChipView(root: HTMLElement, env: OverlayEnvironment): ChipView {
  const doc = root.ownerDocument;

  const chip = element(doc, 'div', 'riki-chip');
  const glyphElement = element(doc, 'span', 'riki-chip__glyph');
  const barsElement = element(doc, 'span', 'riki-chip__bars');
  const textElement = element(doc, 'span', 'riki-chip__text');
  const primaryElement = element(doc, 'span', 'riki-chip__primary');
  const elapsedElement = element(doc, 'span', 'riki-chip__elapsed');
  const hintElement = element(doc, 'span', 'riki-chip__hint');
  const captionElement = element(doc, 'div', 'riki-captions');
  const captionYou = element(doc, 'p', 'riki-captions__line riki-captions__you');
  const captionRiki = element(doc, 'p', 'riki-captions__line riki-captions__riki');

  textElement.append(primaryElement, elapsedElement, hintElement);
  chip.append(glyphElement, barsElement, textElement);
  captionElement.append(captionYou, captionRiki);
  root.append(chip, captionElement);

  // Under reduced motion the amplitude bars become a single static filled bar: still information,
  // no animation (ui-design.md §9.1).
  const barCount = env.reducedMotion ? 1 : Math.max(1, env.barCount);

  const glyph = createGlyphView(glyphElement);
  const bars = createBarsView(barsElement, barCount);
  const text = createTextSlot({
    root: textElement,
    primary: primaryElement,
    elapsed: elapsedElement,
    hint: hintElement,
  });
  const captions = createCaptionPanel({
    root: captionElement,
    you: captionYou,
    riki: captionRiki,
  });

  root.style.setProperty('--riki-scale', String(env.scale));
  captionElement.hidden = true;

  return {
    update(model: ChipViewModel) {
      chip.dataset.state = model.state;
      chip.dataset.phase = model.phase;
      chip.dataset.motion = model.motion;
      chip.classList.toggle('is-latched', model.latched);
      chip.classList.toggle('is-dimmed', model.dimmed);
      // Hidden is a state the renderer draws *leaving*, not a state it draws.
      chip.hidden = model.state === 'hidden' && model.phase !== 'leaving';

      chip.style.setProperty('--riki-accent', `var(${cssVariable(model.accent)})`);
      glyph.set(model.glyph, model.accent);
      bars.setVisible(model.bars !== 'none');
      text.set(model.text);
      captions.set(env.captionsEnabled ? model.captions : null);

      // Affordances are text, never controls — the window takes no pointer event at all (§1.1).
      chip.dataset.affordances = model.affordances.join(' ');
    },

    frame(sample: MotionSample) {
      bars.setHeights(sample.barScales);
      chip.style.opacity = sample.opacity.toFixed(3);
      chip.style.setProperty('--riki-glyph-scale', sample.glyphScale.toFixed(3));
    },

    tickElapsed(seconds: number) {
      text.tickElapsed(seconds);
    },

    dispose() {
      chip.remove();
      captionElement.remove();
    },
  };
}

function element(doc: Document, tag: string, className: string): HTMLElement {
  const created = doc.createElement(tag);
  created.className = className;
  return created;
}

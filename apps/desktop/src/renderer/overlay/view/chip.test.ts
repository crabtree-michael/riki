import { beforeEach, describe, expect, it } from 'vitest';

import { models } from '../testing/models.js';
import { createChipView } from './chip.js';
import type { ChipView } from '../contracts.js';
import type { ChipViewModel, OverlayEnvironment } from '../../../shared/overlay.js';

const ENV: OverlayEnvironment = {
  scale: 1,
  reducedMotion: false,
  highContrast: false,
  captionsEnabled: false,
  barCount: 5,
};

let root: HTMLElement;
let chip: ChipView;

function chipElement(): HTMLElement {
  const found = root.querySelector<HTMLElement>('.riki-chip');
  if (found === null) throw new Error('no chip');
  return found;
}

function bars(): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.riki-bar'));
}

function mount(env: OverlayEnvironment = ENV): void {
  root = document.createElement('div');
  document.body.append(root);
  chip = createChipView(root, env);
}

beforeEach(() => {
  document.body.innerHTML = '';
  mount();
});

describe('createChipView — update', () => {
  it('writes the state, glyph and motion as attributes, so they are readable without pixels', () => {
    chip.update(models.listening());
    expect(chipElement().dataset.state).toBe('listening');
    expect(chipElement().dataset.motion).toBe('amplitude');
    expect(root.querySelector<HTMLElement>('.riki-chip__glyph')?.dataset.glyph).toBe('dot');
  });

  it('takes its accent from the token module, never from a literal', () => {
    chip.update(models.listening());
    expect(chipElement().style.getPropertyValue('--riki-accent')).toBe(
      'var(--riki-accent-listening)',
    );
  });

  it('marks a latched capture, so push and latch are never confused', () => {
    chip.update({ ...models.listening(), latched: true });
    expect(chipElement().classList.contains('is-latched')).toBe(true);

    chip.update({ ...models.listening(), latched: false });
    expect(chipElement().classList.contains('is-latched')).toBe(false);
  });

  it('dims when silence has run past the nudge', () => {
    chip.update({ ...models.listening(), dimmed: true });
    expect(chipElement().classList.contains('is-dimmed')).toBe(true);
  });

  it('hides the bars in a state that has none', () => {
    chip.update(models.confirming());
    expect(root.querySelector<HTMLElement>('.riki-chip__bars')?.hidden).toBe(true);

    chip.update(models.listening());
    expect(root.querySelector<HTMLElement>('.riki-chip__bars')?.hidden).toBe(false);
  });

  it('renders affordances as text, never as controls', () => {
    chip.update(models.confirming());
    expect(chipElement().dataset.affordances).toBe('confirm');
    // The window is click-through: a chip that grew a button would be a chip nobody could press.
    expect(root.querySelectorAll('button, a, input')).toHaveLength(0);
  });

  it('renders a question and its keyboard hint while Confirming', () => {
    chip.update(models.confirming());
    expect(root.querySelector('.riki-chip__primary')?.textContent).toBe('Look at your screen?');
    expect(root.querySelector('.riki-chip__hint')?.textContent).toBe('[Y] yes   [N] no');
  });

  it('collapses the text slot when there is nothing to say', () => {
    chip.update(models.listening());
    expect(root.querySelector<HTMLElement>('.riki-chip__text')?.hidden).toBe(true);
  });
});

describe('createChipView — captions', () => {
  it('renders none by default, which is the whole point of the default', () => {
    chip.update({ ...models.speaking(), captions: { you: 'hello', riki: 'hi' } });
    expect(root.querySelector<HTMLElement>('.riki-captions')?.hidden).toBe(true);
  });

  it('renders them once the setting is on and there is text', () => {
    mount({ ...ENV, captionsEnabled: true });
    chip.update({ ...models.speaking(), captions: { you: 'hello', riki: 'hi' } });

    expect(root.querySelector<HTMLElement>('.riki-captions')?.hidden).toBe(false);
    expect(root.querySelector('.riki-captions__you')?.textContent).toBe('hello');
    expect(root.querySelector('.riki-captions__riki')?.textContent).toBe('hi');
  });

  it('stays away when the setting is on but nothing has been said', () => {
    mount({ ...ENV, captionsEnabled: true });
    chip.update({ ...models.speaking(), captions: { you: null, riki: null } });
    expect(root.querySelector<HTMLElement>('.riki-captions')?.hidden).toBe(true);
  });
});

describe('createChipView — frame', () => {
  it('builds one bar per bar in the environment', () => {
    expect(bars()).toHaveLength(5);
    mount({ ...ENV, reducedMotion: true });
    expect(bars()).toHaveLength(1);
  });

  it('writes only transform and opacity', () => {
    chip.update(models.listening());
    chip.frame({ barScales: [1, 0.5, 0.2, 0.5, 1], opacity: 0.8, glyphScale: 1.1 });

    for (const bar of bars()) {
      expect(bar.style.transform).toMatch(/^scaleY\(/);
      // Height stays in CSS: a frame that changed it would put layout on the animation path.
      expect(bar.style.height).toBe('');
    }
    expect(chipElement().style.opacity).toBe('0.800');
    expect(chipElement().style.getPropertyValue('--riki-glyph-scale')).toBe('1.100');
  });

  it('scales monotonically with the sample', () => {
    chip.update(models.listening());
    chip.frame({ barScales: [0, 0, 0, 0, 0], opacity: 1, glyphScale: 1 });
    const quiet = scaleOf(bars()[0]);

    chip.frame({ barScales: [1, 1, 1, 1, 1], opacity: 1, glyphScale: 1 });
    expect(scaleOf(bars()[0])).toBeGreaterThan(quiet);
  });

  it('never collapses a bar to nothing, so silence still reads as a meter', () => {
    chip.update(models.listening());
    chip.frame({ barScales: [0, 0, 0, 0, 0], opacity: 1, glyphScale: 1 });
    expect(scaleOf(bars()[0])).toBeGreaterThan(0);
  });

  it('reuses the last height when the sample is shorter than the bar count', () => {
    chip.update(models.listening());
    expect(() => {
      chip.frame({ barScales: [0.5], opacity: 1, glyphScale: 1 });
    }).not.toThrow();
    expect(scaleOf(bars()[4])).toBeGreaterThan(0);
  });
});

describe('createChipView — the elapsed counter', () => {
  it('starts from what main measured', () => {
    chip.update(processingFor(2_500));
    expect(root.querySelector('.riki-chip__elapsed')?.textContent).toBe('3s');
  });

  it('ticks without re-running update', () => {
    chip.update(processingFor(2_500));
    chip.tickElapsed(11);
    expect(root.querySelector('.riki-chip__elapsed')?.textContent).toBe('11s');
    // Still the same element: no re-render, no reflow of the rest of the chip.
    expect(root.querySelectorAll('.riki-chip__elapsed')).toHaveLength(1);
  });

  it('goes away when the state has no counter', () => {
    chip.update(processingFor(2_500));
    chip.update(models.listening());
    expect(root.querySelector<HTMLElement>('.riki-chip__elapsed')?.hidden).toBe(true);
  });
});

describe('createChipView — dispose', () => {
  it('leaves nothing behind', () => {
    chip.update(models.listening());
    chip.dispose();
    expect(root.querySelector('.riki-chip')).toBeNull();
    expect(root.querySelector('.riki-captions')).toBeNull();
  });
});

function scaleOf(element: HTMLElement | undefined): number {
  const match = /scaleY\(([\d.]+)\)/.exec(element?.style.transform ?? '');
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function processingFor(elapsedMs: number): ChipViewModel {
  return { ...models.processing(), text: { primary: '', elapsedMs } };
}

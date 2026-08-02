/**
 * Scroll preservation, against a hand-built column with hand-built geometry.
 *
 * Tier 1, and it has to be: `happy-dom` lays nothing out, so every rect it reports is zero and a
 * test that leaned on the real thing would assert against a document where the top of the viewport
 * and the bottom of the buffer are the same pixel. The model here is deliberately crude — rows are
 * 100 px tall, the viewport is 300 — because the arithmetic is the whole of what is being checked.
 *
 * What is asserted is the behaviour a reader complains about when it is missing: a row they are
 * looking at stays where it is while newer rows are prepended above it, and the two edges keep
 * following what arrives.
 *
 * One test deliberately leaves the crude model behind. Rows in the real window are 165.5 px tall
 * and Chromium's scroll offsets are whole pixels, and the interaction of those two facts drifts the
 * anchor half a pixel per frame — found in an Electron window, not here, because `happy-dom` stores
 * a fractional `scrollTop` quite happily. `snapScrollToWholePixels` is what brings it in range.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { captureScroll, restoreScroll } from './scroll.js';

const VIEWPORT_PX = 300;

let container: HTMLElement;
/** Row height. A test may make it fractional; a real one measured 165.5. */
let rowPx = 100;

/**
 * Replaces the column's rows and stubs the geometry a real layout would have produced.
 *
 * The rects are closures over `container.scrollTop` rather than fixed numbers, because that is the
 * relationship `restoreScroll` manipulates: it moves the container and expects the rows to move.
 */
function layout(keys: readonly string[]): void {
  const rows = keys.map((key, index) => {
    const row = document.createElement('div');
    row.dataset.insKey = key;
    row.getBoundingClientRect = () => rect(index * rowPx - container.scrollTop);
    return row;
  });
  container.replaceChildren(...rows);
  Object.defineProperty(container, 'scrollHeight', {
    configurable: true,
    get: () => keys.length * rowPx,
  });
}

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top + rowPx,
    left: 0,
    right: 0,
    width: 0,
    height: rowPx,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

/** Where a row's top edge currently sits relative to the container's, read back off the stubs. */
function offsetOf(key: string): number | null {
  const row = container.querySelector<HTMLElement>(`[data-ins-key="${key}"]`);
  return row === null ? null : row.getBoundingClientRect().top;
}

/** The key of the row sitting at the top of the viewport, read back off the stubs. */
function topRow(): string | null {
  for (const row of Array.from(container.querySelectorAll<HTMLElement>('[data-ins-key]'))) {
    if (row.getBoundingClientRect().top >= 0) return row.dataset.insKey ?? null;
  }
  return null;
}

beforeEach(() => {
  document.body.replaceChildren();
  rowPx = 100;
  container = document.createElement('div');
  document.body.append(container);
  container.getBoundingClientRect = () => rect(0);
  Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => VIEWPORT_PX });
  container.scrollTop = 0;
});

/**
 * Makes `scrollTop` behave the way Chromium's does: whole pixels only.
 *
 * `happy-dom` stores whatever you assign, which is the one respect in which it is *more* capable
 * than the real thing and the reason the drift below could not be caught without this.
 */
function snapScrollToWholePixels(): void {
  let offset = container.scrollTop;
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => offset,
    set: (next: number) => {
      offset = Math.round(next);
    },
  });
}

describe('the reader is mid-buffer', () => {
  it('holds the row they are reading still while newer ones are prepended above it', () => {
    layout(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']);
    container.scrollTop = 400;
    expect(topRow()).toBe('a4');

    const position = captureScroll(container);
    expect(position.anchorKey).toBe('a4');

    // Two ticks arrive. The panels that grow render newest-first, so they land *above* everything
    // the reader can see, and every pixel offset below them is now wrong by 200.
    layout(['new1', 'new0', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']);
    restoreScroll(container, position);

    expect(container.scrollTop).toBe(600);
    expect(topRow()).toBe('a4');
  });

  it('keeps the row at the same height, not merely on screen', () => {
    layout(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    container.scrollTop = 150; // a1 is half a row above the fold.
    const position = captureScroll(container);
    expect(position.anchorKey).toBe('a1');
    expect(position.anchorOffset).toBe(-50);

    layout(['new0', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    restoreScroll(container, position);

    expect(container.scrollTop).toBe(250);
    expect(container.children[2]?.getBoundingClientRect().top).toBe(-50);
  });

  it('does not let a fractional row height walk the anchor down the screen', () => {
    // Measured in a real Electron window: a tick renders 165.5 px tall, and a scroll offset is
    // whole pixels, so half of every correction is unspendable. Restoring against wherever the last
    // frame landed loses that half each time — 0.5 px per frame is 120 px a minute at 4 Hz, which
    // is this file's own bug arriving slowly instead of all at once.
    rowPx = 165.5;
    snapScrollToWholePixels();

    const rows = (extra: number): string[] => [
      ...Array.from({ length: extra }, (_, i) => `new${String(i)}`),
      ...Array.from({ length: 30 }, (_, i) => `a${String(i)}`),
    ];

    layout(rows(0));
    container.scrollTop = 2000;
    const started = offsetOf('a15');
    expect(started).not.toBeNull();

    // One minute of frames, one new row on each.
    for (let frame = 1; frame <= 240; frame += 1) {
      const position = captureScroll(container);
      layout(rows(frame));
      restoreScroll(container, position);
    }

    // Within a pixel, not exactly equal: half a pixel is genuinely unspendable, so the row settles
    // into oscillating across one pixel boundary. What must not happen is that it keeps going.
    expect(Math.abs((offsetOf('a15') ?? 0) - (started ?? 0))).toBeLessThanOrEqual(1);
  });

  it('falls back to the old offset when the anchor has fallen off the end of the buffer', () => {
    layout(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']);
    container.scrollTop = 400;
    const position = captureScroll(container);

    // The hub's ring buffers are capped, so this happens to anyone who scrolls far enough back and
    // waits. Wrong by however much was prepended, and still not the top of the document.
    layout(['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']);
    restoreScroll(container, position);

    expect(container.scrollTop).toBe(400);
  });

  it('falls back to the old offset when nothing in the column carries a key', () => {
    layout(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    container.scrollTop = 200;
    const position = captureScroll(container);
    expect(position.anchorKey).toBe('a2');

    container.replaceChildren(document.createElement('div'));
    restoreScroll(container, position);

    expect(container.scrollTop).toBe(200);
  });
});

describe('the two edges', () => {
  it('stays at the top, where the newest rows arrive', () => {
    layout(['a0', 'a1', 'a2', 'a3']);
    const position = captureScroll(container);
    expect(position.atTop).toBe(true);

    layout(['new0', 'a0', 'a1', 'a2', 'a3']);
    restoreScroll(container, position);

    // Newest-first, so this is the "follow the log" position — the one the freeze button exists to
    // get you *out* of.
    expect(container.scrollTop).toBe(0);
    expect(topRow()).toBe('new0');
  });

  it('stays at the bottom, keeping the oldest row in view as the buffer grows', () => {
    layout(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']);
    container.scrollTop = 700; // 1000 px of rows, 300 px of viewport.
    const position = captureScroll(container);
    expect(position.atBottom).toBe(true);

    layout(['new1', 'new0', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']);
    restoreScroll(container, position);

    expect(container.scrollTop).toBe(900);
    expect(topRow()).toBe('a7');
  });

  it('reads a column shorter than its viewport as at the top, not at the bottom', () => {
    layout(['a0']);
    const position = captureScroll(container);
    // Both tests pass on a 100 px column in a 300 px viewport. Pinning it to a bottom that does not
    // exist would drag it to 0 anyway, but it would also throw the anchor away on the way there.
    expect(position.atTop).toBe(true);
    expect(position.atBottom).toBe(false);
  });

  it('treats four pixels off the top as the top, because a trackpad rarely lands on zero', () => {
    layout(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    container.scrollTop = 3;
    expect(captureScroll(container).atTop).toBe(true);

    container.scrollTop = 40;
    expect(captureScroll(container).atTop).toBe(false);
  });
});

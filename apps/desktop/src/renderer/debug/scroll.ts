/**
 * Keeps a scroll container under the reader's eye while its contents are rebuilt.
 *
 * `app.ts` redraws the whole document every frame — 4 Hz, a few hundred nodes — and that is worth
 * keeping (see its header for why). What is not worth keeping is the consequence: a reader who
 * scrolled up to study a gate ladder was returned to the top a quarter of a second later, every
 * time, which made the window unreadable while the thing it describes is happening.
 *
 * Two decisions, and the second is the one that matters here.
 *
 * **The container survives the redraw.** `app.ts` keeps the three `.ins-column` elements alive and
 * replaces only their children, because `scrollTop` belongs to the element: a column rebuilt from
 * scratch has no position to preserve, and no amount of restoring afterwards can invent one.
 *
 * **The position is content, not a number.** The panels that grow — Triggers, Coach turns, Problems
 * — render newest-first, so a new tick is *prepended* and every pixel offset below it becomes wrong
 * the moment it arrives. Restoring a saved `scrollTop` against that would let the row you are
 * reading crawl down the screen four times a second, which is the same complaint in slower motion.
 * So the anchor is the topmost thing on screen, found again by its `data-ins-key` and put back at
 * the same height. `view.ts` stamps those keys; `scroll.ts` never invents one.
 *
 * The two edges are pinned instead, because there the reader's intent is clearer than any anchor:
 * at the top means *follow the newest* (which, newest-first, is where new rows appear), and at the
 * bottom means *keep the oldest row in view* — the chat-log behaviour, and the one that keeps the
 * end of the buffer still while the buffer grows above it.
 */

/** Slack, in CSS pixels, for "already at the top" and "already at the bottom". */
const EDGE_SLACK_PX = 4;

/** The attribute `view.ts` stamps on anything worth finding again after a redraw. */
const ANCHOR_ATTRIBUTE = 'data-ins-key';

export interface ScrollPosition {
  /** The raw offset, kept only as the fallback for when the anchor is gone from the buffer. */
  readonly scrollTop: number;
  readonly atTop: boolean;
  readonly atBottom: boolean;
  /** `data-ins-key` of the topmost element on screen, or null when there was nothing to anchor to. */
  readonly anchorKey: string | null;
  /** Where that element's top edge sat relative to the container's, in px. Usually ≤ 0. */
  readonly anchorOffset: number;
}

/** Reads where the reader is looking, before the container's children are replaced. */
export function captureScroll(container: HTMLElement): ScrollPosition {
  const { scrollTop } = container;
  const scrollable = container.scrollHeight - container.clientHeight;

  const atTop = scrollTop <= EDGE_SLACK_PX;
  // `scrollable > EDGE_SLACK_PX` is load-bearing: a container with nothing to scroll satisfies the
  // bottom test trivially, and so does one whose geometry is unmeasurable. Pinning either to a
  // bottom that does not exist would throw away the anchor for no reason.
  const atBottom = !atTop && scrollable > EDGE_SLACK_PX && scrollable - scrollTop <= EDGE_SLACK_PX;

  if (atTop || atBottom) {
    return { scrollTop, atTop, atBottom, anchorKey: null, anchorOffset: 0 };
  }

  const containerTop = container.getBoundingClientRect().top;
  let anchorKey: string | null = null;
  let anchorOffset = 0;
  for (const node of anchors(container)) {
    const key = node.dataset.insKey;
    if (key === undefined) continue;
    const offset = node.getBoundingClientRect().top - containerTop;
    // The last element at or above the fold — which, because the keys nest, is the most specific
    // one there: a tick rather than the panel holding it. Failing that, the first element below it,
    // for the case where a tall row starts above the viewport and no key does.
    if (offset <= EDGE_SLACK_PX || anchorKey === null) {
      anchorKey = key;
      // Rounded, and this is the line that stops a slow crawl. A rect is fractional and a scroll
      // offset is not: Chromium snaps `scrollTop` to a whole pixel, so a row 165.5 px tall cannot
      // be scrolled past exactly and half a pixel of every correction is lost. Measured before this
      // was rounded: 0.5 px per frame, which at 4 Hz walked the row being read 120 px down the
      // screen in a minute. Recording a whole-pixel target instead makes the next frame aim at the
      // same number rather than at wherever the last one landed, so the error oscillates inside one
      // pixel instead of accumulating.
      anchorOffset = Math.round(offset);
    }
  }

  return { scrollTop, atTop, atBottom, anchorKey, anchorOffset };
}

/** Puts the reader back where `captureScroll` found them, against the new children. */
export function restoreScroll(container: HTMLElement, position: ScrollPosition): void {
  if (position.atTop) {
    container.scrollTop = 0;
    return;
  }
  if (position.atBottom) {
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    return;
  }

  if (position.anchorKey !== null) {
    const anchor = findAnchor(container, position.anchorKey);
    if (anchor !== null) {
      // Relative, not absolute: the browser has already clamped `scrollTop` against the new content
      // by the time we read it here, and moving by the anchor's drift lands correctly either way.
      // Rounded because `anchorOffset` is — see `captureScroll`.
      const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop = Math.round(container.scrollTop + offset - position.anchorOffset);
      return;
    }
  }

  // The anchor fell off the end of a ring buffer. The old offset is wrong by however much was
  // prepended, and it is still very much better than the top of the document.
  container.scrollTop = position.scrollTop;
}

function findAnchor(container: HTMLElement, key: string): HTMLElement | null {
  // Compared rather than selected on, because these keys carry hero names, fact paths and a
  // sidecar's own words — none of which we are willing to have parsed as a selector.
  for (const node of anchors(container)) {
    if (node.dataset.insKey === key) return node;
  }
  return null;
}

/**
 * Every keyed element in the container, in document order.
 *
 * `Array.from` rather than iterating the NodeList: the renderer's `lib` is `DOM` without
 * `DOM.Iterable`, under which a `for…of` over one is silently `any` and every read off it is too.
 */
function anchors(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTRIBUTE}]`));
}

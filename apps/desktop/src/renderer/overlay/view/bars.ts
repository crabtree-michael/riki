/**
 * The level bars.
 *
 * `scaleY` on pre-sized elements, never a height change: height is layout, and ui-design.md §10
 * allows only transform and opacity on the per-frame path. The bars are created once, at the count
 * the environment asks for — under reduced motion that count is one, because the amplitude carries
 * real information and must not simply disappear (ui-design.md §9.1).
 */

import type { BarsView } from '../contracts.js';

/** Matches `--riki-bar-min-height` over `--riki-bar-max-height`, so a silent bar is still a bar. */
const MIN_SCALE = 4 / 18;

export function createBarsView(container: HTMLElement, count: number): BarsView {
  const bars: HTMLElement[] = [];

  for (let index = 0; index < count; index += 1) {
    const bar = container.ownerDocument.createElement('i');
    bar.className = 'riki-bar';
    container.append(bar);
    bars.push(bar);
  }

  return {
    setHeights(heights) {
      bars.forEach((bar, index) => {
        const height = heights[index] ?? heights[heights.length - 1] ?? 0;
        const scale = MIN_SCALE + (1 - MIN_SCALE) * clamp(height, 0, 1);
        bar.style.transform = `scaleY(${scale.toFixed(3)})`;
      });
    },

    setVisible(visible) {
      container.hidden = !visible;
    },
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

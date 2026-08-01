/**
 * The overlay renderer's entry point.
 *
 * The chip: states, motion, and level bars, drawn into a click-through layered window with
 * per-pixel alpha. Colours come from the token module, never from literals — a lint rule enforces
 * it so the "no red" rule has one place to live (§6.2).
 *
 * The architecture — how this view is driven, and why the state that drives it is not in here —
 * is docs/design/overlay-architecture.md §7.
 *
 * ⚠ Nothing loads this yet. `index.html` expects a compiled `index.js` beside it, and the build
 * that produces one — along with the app entry that points a BrowserWindow at it — belongs to the
 * apps/desktop shell (REPO_SKELETON.md §10 step 6), not to this component. Until that lands, the
 * component is exercised by its unit tests rather than by a window.
 */

import { mountOverlay } from './app.js';
import { OVERLAY_BRIDGE_KEY } from '../../shared/channels.js';
import type { RikiOverlayBridge } from '../../shared/overlay.js';

export type * from './contracts.js';
export { mountOverlay, DEFAULT_ENVIRONMENT } from './app.js';
export { createChipView } from './view/chip.js';
export { createMotionDirector, settlesAtMs } from './motion/director.js';
export { createAnimationClock } from './motion/clock.js';
export { createLevelBallistics } from './level/ballistics.js';
export { createTokenModule, cssVariable, HIGH_CONTRAST_CLASS } from './tokens/index.js';

/** The preload bridge is the only thing on `window` that this renderer is allowed to see. */
interface OverlayWindow extends Window {
  readonly [OVERLAY_BRIDGE_KEY]?: RikiOverlayBridge;
}

function start(): void {
  const root = document.getElementById('riki-root');
  const bridge = (window as OverlayWindow)[OVERLAY_BRIDGE_KEY];
  // No logger here by design: the renderer reports through the bridge, and with no bridge there
  // is nothing to report through. Failing quietly beats a window that throws on load.
  if (root === null || bridge === undefined) return;
  mountOverlay(root, bridge);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

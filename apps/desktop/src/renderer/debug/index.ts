/**
 * The inspector renderer's entry point.
 *
 * The dev-only window that answers *what does Riki currently believe, what did it nearly say, and
 * why did it stay quiet*, and — since ADR-0037 — *what happens if I move this number*. It reads a
 * `DebugFrame` and can send four things, two of which change a setting the coach reads; see
 * `main/debug/controls.ts` for what they can and cannot reach.
 *
 * Loaded by `main/debug/electron-window.ts`, which points a `BrowserWindow` at the `index.html`
 * beside this file. Unlike the overlay, whose entry warned that nothing loaded it, this one is
 * reached the moment somebody turns on `debug.enabled` and clicks the tray's Inspector row.
 */

import { mountInspector } from './app.js';
import { DEBUG_BRIDGE_KEY } from '../../shared/channels.js';
import type { RikiDebugBridge } from '../../shared/debug.js';

export * from './view.js';
export { mountInspector } from './app.js';
export type { InspectorHandle } from './app.js';

/** The preload bridge is the only thing on `window` that this renderer is allowed to see. */
interface InspectorWindow extends Window {
  readonly [DEBUG_BRIDGE_KEY]?: RikiDebugBridge;
}

function start(): void {
  const root = document.getElementById('riki-debug');
  const bridge = (window as InspectorWindow)[DEBUG_BRIDGE_KEY];
  // No logger here by design: the renderer reports through the bridge, and with no bridge there is
  // nothing to report through. The same shape as the overlay's entry, and for the same reason.
  if (root === null || bridge === undefined) return;
  mountInspector(root, bridge);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

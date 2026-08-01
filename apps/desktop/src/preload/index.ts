/**
 * The only bridge between main and renderer. contextIsolation stays on and the renderer gets no
 * Node access.
 *
 * Nothing secret crosses here — the API key is resolved in main by @riki/config and never
 * reaches the renderer (§7.1).
 *
 * This module is the overlay window's preload entry: importing it exposes the bridge. Other
 * windows get their own entry, because each should see only the surface it needs.
 */

import { exposeOverlayBridge } from './overlay-bridge.js';

export * from './overlay-bridge.js';

exposeOverlayBridge();

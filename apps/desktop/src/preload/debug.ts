/**
 * The inspector window's preload entry.
 *
 * A second entry rather than a wider `index.ts`, which is what that file's header already promised:
 * *"Other windows get their own entry, because each should see only the surface it needs."* The
 * overlay never has a reason to read a `DebugFrame`, and the inspector never has a reason to send a
 * `cancel` into the interaction machine — so neither is given the other's bridge, and that is
 * enforced by which script each `BrowserWindow` loads rather than by anything at runtime.
 *
 * Nothing secret crosses here either: the API key is resolved in main by @riki/config and never
 * reaches a renderer (§7.1).
 */

import { exposeDebugBridge } from './debug-bridge.js';

export * from './debug-bridge.js';

exposeDebugBridge();

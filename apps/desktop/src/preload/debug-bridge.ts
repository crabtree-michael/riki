/**
 * The inspector's half of the preload boundary — two functions, and one of them only sends.
 *
 * It is narrower than the overlay's on purpose. The overlay's bridge has a `send` that reaches the
 * interaction machine (`cancel` is a real input to it); this one's reaches nothing that can change
 * the app's behaviour at all. `ready` asks for a frame the renderer was going to get anyway, and
 * `fault` is how a renderer with no logger reports that it broke. There is deliberately no
 * `setQuietMode`, no `evaluate`, no "replay this tick" — an inspector that can poke the thing it
 * inspects produces readings nobody can act on.
 *
 * The same three window settings hold as for the overlay: `contextIsolation`, no Node, and
 * `sandbox: true`. This renderer displays live match state and rendered model input, so it must be
 * exactly as unprivileged as the one that draws a chip.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { DebugCommand, RikiDebugBridge } from '../shared/debug.js';
import { DEBUG_BRIDGE_KEY, DEBUG_CHANNELS } from '../shared/channels.js';
import { parseDebugIntent } from '../shared/intents.js';

export { DEBUG_BRIDGE_KEY, DEBUG_CHANNELS };
export type { RikiDebugBridge };

export function createDebugBridge(): RikiDebugBridge {
  return {
    onCommand(fn) {
      const listener = (_event: unknown, payload: unknown): void => {
        // Structured-cloned from main, the only sender on this channel. The cast is the trust
        // boundary and it points the safe way: main is more privileged than we are.
        fn(payload as DebugCommand);
      };
      ipcRenderer.on(DEBUG_CHANNELS.command, listener);
      return () => void ipcRenderer.removeListener(DEBUG_CHANNELS.command, listener);
    },

    send(intent) {
      // Normalised, not forwarded: only the fields the allow-list names cross the boundary.
      const checked = parseDebugIntent(intent);
      if (checked === null) return;
      ipcRenderer.send(DEBUG_CHANNELS.intent, checked);
    },
  };
}

export function exposeDebugBridge(): void {
  contextBridge.exposeInMainWorld(DEBUG_BRIDGE_KEY, createDebugBridge());
}

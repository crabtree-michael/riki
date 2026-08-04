/**
 * The inspector's half of the preload boundary — two functions, and one of them only sends.
 *
 * `send` used to reach nothing that could change the app's behaviour. Since ADR-0037 it reaches one
 * thing: `control`, which moves a setting the coach reads. That makes this the widest renderer
 * surface in the app, and it is why the check below is not the only one — this boundary can ask
 * whether a payload is *shaped* like a control intent, and main asks the question that matters,
 * which is whether the id names a registered, unlocked control (`main/debug/controls.ts`).
 *
 * ADR-0038 adds `rehearse`, which is the first intent that *does* something rather than setting
 * something — and the same split applies: this boundary checks that a state id is a bounded string,
 * and main checks whether it names a row in a library it assembled from one directory. What it runs
 * is a scratch world, a scratch coach and a scratch context, so a rehearsal reaches nothing the live
 * match uses.
 *
 * What is still deliberately absent: "replay this tick", "say this now", and any way to name a field
 * or a file rather than a registered control or a listed mock state. The window can turn knobs the
 * app was built with and ask the coach a question in a sandbox; it cannot make Riki speak.
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

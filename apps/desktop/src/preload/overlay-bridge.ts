/**
 * The overlay's half of the preload bridge — three functions, and no escape hatches.
 *
 * `contextIsolation` stays on, no Node object is exposed, and nothing secret crosses: the API key
 * is resolved by @riki/config in main and injected into @riki/realtime, so there is no code path
 * from it to this file (REPO_SKELETON.md §7.1, and §5.4 tests its absence from this surface).
 *
 * Outbound intents are allow-listed here as well as in main. Two checks for the same thing is
 * deliberate: this one keeps a renderer *bug* from reaching IPC at all, and main's keeps a
 * compromised renderer from reaching the machine (docs/design/overlay-architecture.md §6.2).
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { LevelFrame, OverlayCommand, RikiOverlayBridge } from '../shared/overlay.js';
import { OVERLAY_BRIDGE_KEY, OVERLAY_CHANNELS } from '../shared/channels.js';
import { parseOverlayIntent } from '../shared/intents.js';

/**
 * The bridge's *shape* and the channel names live in shared/, because main and the renderer both
 * have to name them and neither may import this module — it imports `electron`.
 */
export { OVERLAY_BRIDGE_KEY, OVERLAY_CHANNELS };
export type { RikiOverlayBridge };

export function createOverlayBridge(): RikiOverlayBridge {
  return {
    onCommand(fn) {
      const listener = (_event: unknown, payload: unknown): void => {
        // Structured-cloned from main, the only sender on this channel. The cast is the trust
        // boundary, and it points the safe way: main is more privileged than we are.
        fn(payload as OverlayCommand);
      };
      ipcRenderer.on(OVERLAY_CHANNELS.command, listener);
      return () => void ipcRenderer.removeListener(OVERLAY_CHANNELS.command, listener);
    },

    onLevel(fn) {
      const listener = (_event: unknown, payload: unknown): void => {
        fn(payload as LevelFrame);
      };
      ipcRenderer.on(OVERLAY_CHANNELS.level, listener);
      return () => void ipcRenderer.removeListener(OVERLAY_CHANNELS.level, listener);
    },

    send(intent) {
      // Normalised, not forwarded: only the fields the allow-list names cross the boundary.
      const checked = parseOverlayIntent(intent);
      if (checked === null) return;
      ipcRenderer.send(OVERLAY_CHANNELS.intent, checked);
    },
  };
}

export function exposeOverlayBridge(): void {
  contextBridge.exposeInMainWorld(OVERLAY_BRIDGE_KEY, createOverlayBridge());
}

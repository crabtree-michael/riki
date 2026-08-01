/**
 * The overlay's half of the preload bridge — three functions, and no escape hatches.
 *
 * `contextIsolation` stays on, no Node object is exposed, and nothing secret crosses: the API key
 * is resolved by @riki/config in main and injected into @riki/realtime, so there is no code path
 * from it to this file (REPO_SKELETON.md §7.1, and §5.4 tests its absence from this surface).
 *
 * Inbound intents are validated and allow-listed before they reach the machine. The renderer is
 * the least privileged process in the app and is treated as untrusted input.
 *
 * Declarations only. See docs/design/overlay-architecture.md §6.
 */

import type { LevelFrame, OverlayCommand, OverlayIntent, Unsubscribe } from '../shared/overlay.js';

/** Exposed as `window.rikiOverlay`. This is the entire API available to the chip. */
export interface RikiOverlayBridge {
  onCommand(fn: (command: OverlayCommand) => void): Unsubscribe;
  onLevel(fn: (frame: LevelFrame) => void): Unsubscribe;
  send(intent: OverlayIntent): void;
}

/** Channel names, kept in one place so main and preload cannot drift (§6.1). */
export const OVERLAY_CHANNELS = {
  command: 'riki:overlay:command',
  level: 'riki:overlay:level',
  intent: 'riki:overlay:intent',
} as const;

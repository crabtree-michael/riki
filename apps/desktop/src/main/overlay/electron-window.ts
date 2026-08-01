/**
 * The only file in the overlay component that imports Electron.
 *
 * Every property of this `BrowserWindow` configuration is load-bearing, and four of them carry
 * design decisions rather than taste — docs/design/overlay-architecture.md §3.3 says which and
 * why. Changing one of them changes the product, not the plumbing.
 *
 * ⚠ Unverified against a game. §12 of that document lists what has to be measured on real
 * hardware before anything is built on top of these settings, and the anti-cheat spike (B1,
 * docs/runbooks/anticheat-validation.md) is still unrun. macOS is the primary target here.
 */

import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';

import type {
  LevelFrame,
  OverlayCommand,
  OverlayIntent,
  Unsubscribe,
} from '../../shared/overlay.js';
import { OVERLAY_CHANNELS } from '../../shared/channels.js';
import { parseOverlayIntent } from '../../shared/intents.js';
import type { Rectangle } from './contracts.js';
import type { OverlayWindow, OverlayWindowFactory } from './window-port.js';

export interface ElectronOverlayWindowOptions {
  /** Absolute path to the compiled preload script. */
  readonly preloadPath: string;
  /** Absolute path to the overlay renderer's document. */
  readonly entryPath: string;
}

export function createElectronOverlayWindowFactory(
  options: ElectronOverlayWindowOptions,
): OverlayWindowFactory {
  return { create: () => createElectronOverlayWindow(options) };
}

function createElectronOverlayWindow(options: ElectronOverlayWindowOptions): OverlayWindow {
  const win = new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    // The overlay must never steal focus from the game.
    focusable: false,
    skipTaskbar: true,
    // Created hidden and never destroyed between sessions: "hidden renders no window" means no
    // *composited* window, not constructing one per key press — which cannot meet 100 ms (§3.3).
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium throttles timers and rAF in windows that are not visible. A warm-but-throttled
      // renderer can take up to a second to produce its first frame after `show()`, which spends
      // the entire budget on something invisible in a profile.
      backgroundThrottling: false,
      preload: options.preloadPath,
    },
  });

  // These two calls are a pair on macOS, the primary target, and the second is the one that is
  // easy to omit (ui-design.md §6.5). A game in *native* full-screen gets its own Space, and an
  // always-on-top window is not composited over it unless the window opts in — so without
  // `setVisibleOnAllWorkspaces` the chip works perfectly in windowed mode and is invisible in the
  // only mode that matters. Neither is asserted anywhere yet: that is an e2e test, and there is
  // no harness.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // No pointer event reaches this window at all, which is also why the chip can carry no
  // clickable affordance — `Esc ✕` and `[Y] yes` are keyboard hints rendered as text (§1.1).
  win.setIgnoreMouseEvents(true);

  const listeners = new Set<(intent: OverlayIntent) => void>();

  const onIntentMessage = (event: IpcMainEvent, payload: unknown): void => {
    if (event.sender !== win.webContents) return;
    const intent = parseOverlayIntent(payload);
    // The renderer is the least privileged process in the app and is treated as untrusted input:
    // anything that is not an allow-listed intent is dropped, not forwarded (§6.2).
    if (intent === null) return;
    for (const listener of [...listeners]) listener(intent);
  };

  ipcMain.on(OVERLAY_CHANNELS.intent, onIntentMessage);

  let disposed = false;

  return {
    async load() {
      await win.loadFile(options.entryPath);
      // Wait for a real first paint, not merely for the load event: that is the difference between
      // `showFast()` mapping an existing surface and cold-starting a renderer.
      await new Promise<void>((resolve) => {
        if (win.isDestroyed()) {
          resolve();
          return;
        }
        win.webContents.once('paint', () => {
          resolve();
        });
        // `paint` only fires for offscreen windows, so on a normal one this is the event that
        // arrives. Both are subscribed because which one fires is the claim §12 asks us to check.
        win.once('ready-to-show', () => {
          resolve();
        });
      });
    },

    showInactive() {
      if (!win.isDestroyed()) win.showInactive();
    },

    hide() {
      if (!win.isDestroyed()) win.hide();
    },

    isVisible() {
      return !win.isDestroyed() && win.isVisible();
    },

    send(command: OverlayCommand) {
      if (!win.isDestroyed()) win.webContents.send(OVERLAY_CHANNELS.command, command);
    },

    sendLevel(frame: LevelFrame) {
      if (!win.isDestroyed()) win.webContents.send(OVERLAY_CHANNELS.level, frame);
    },

    setBounds(bounds: Rectangle) {
      if (!win.isDestroyed()) win.setBounds(bounds);
    },

    setContentProtection(on: boolean) {
      if (!win.isDestroyed()) win.setContentProtection(on);
    },

    onIntent(fn): Unsubscribe {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    destroy() {
      if (disposed) return;
      disposed = true;
      ipcMain.removeListener(OVERLAY_CHANNELS.intent, onIntentMessage);
      listeners.clear();
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/**
 * The only file in the inspector that imports Electron.
 *
 * Every window setting here is the **opposite** of the overlay's, and the contrast is the design.
 * The overlay is `frame: false`, `transparent`, `focusable: false`, click-through, always-on-top,
 * created hidden and never destroyed — because it is a chip that must never take a key press from
 * the game. The inspector is an ordinary window with a title bar, a scrollbar and focus, because it
 * is a tool a developer reads on a second monitor while the game has the first.
 *
 * Three things it keeps from the overlay's configuration, and all three are non-negotiable:
 * `contextIsolation`, `nodeIntegration: false` and `sandbox: true`. A debug window is exactly the
 * surface where a "just for development" relaxation would be tempting and exactly the one where it
 * would be worst — this renderer displays match state and rendered model input, so it must be no
 * more privileged than the overlay.
 *
 * ## Lifetime
 *
 * Created on demand and **destroyed on close**, which is the reverse of the overlay again. The
 * overlay is warmed and kept because it has a 100 ms visibility budget; the inspector has none, and
 * a window that is usually closed should usually not exist — a renderer holding a `DebugFrame`
 * every 250 ms for a whole match while nobody looks at it is exactly the kind of cost a debug tool
 * must not impose on the thing it is measuring.
 */

import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';

import type { DebugCommand, DebugIntent } from '../../shared/debug.js';
import { DEBUG_CHANNELS } from '../../shared/channels.js';
import { parseDebugIntent } from '../../shared/intents.js';
import type { Unsubscribe } from '../../shared/overlay.js';
import type { DebugWindow, DebugWindowFactory } from './contracts.js';

/** Wide enough for the gate ladder's thirteen rows beside a snapshot, tall enough to scroll little. */
const DEFAULT_WIDTH = 1_280;
const DEFAULT_HEIGHT = 900;

export interface ElectronDebugWindowOptions {
  /** Absolute path to the compiled inspector preload script. Not the overlay's. */
  readonly preloadPath: string;
  /** Absolute path to the inspector renderer's document. */
  readonly entryPath: string;
}

export function createElectronDebugWindowFactory(
  options: ElectronDebugWindowOptions,
): DebugWindowFactory {
  return { create: () => createElectronDebugWindow(options) };
}

function createElectronDebugWindow(options: ElectronDebugWindowOptions): DebugWindow {
  let win: BrowserWindow | null = null;
  let destroyed = false;

  const intentListeners = new Set<(intent: DebugIntent) => void>();
  const closedListeners = new Set<() => void>();

  const onIntentMessage = (event: IpcMainEvent, payload: unknown): void => {
    // Same two-boundary allow-list as the overlay's, and the sender check matters more here than it
    // used to: this channel is live for as long as the app is, the inspector window is not the only
    // renderer, and since ADR-0037 two of the four intents change what the coach does. A `control`
    // arriving from the overlay's webContents must not be honoured just because it parses.
    if (event.sender !== win?.webContents) return;
    const intent = parseDebugIntent(payload);
    if (intent === null) return;
    for (const listener of [...intentListeners]) listener(intent);
  };

  ipcMain.on(DEBUG_CHANNELS.intent, onIntentMessage);

  return {
    async open(): Promise<void> {
      if (destroyed) return;
      if (win?.isDestroyed() === false) {
        win.focus();
        return;
      }

      const created = new BrowserWindow({
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        title: 'Riki Inspector',
        show: false,
        // Never over the game. The inspector is for the second monitor; an always-on-top debug
        // window would be the most annoying thing in a product whose promise is invisibility.
        alwaysOnTop: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: options.preloadPath,
        },
      });
      win = created;

      created.on('closed', () => {
        if (win === created) win = null;
        for (const listener of [...closedListeners]) listener();
      });

      await created.loadFile(options.entryPath);
      if (!created.isDestroyed()) created.show();
    },

    close(): void {
      if (win !== null && !win.isDestroyed()) win.close();
    },

    isOpen(): boolean {
      return win !== null && !win.isDestroyed();
    },

    send(command: DebugCommand): void {
      if (win !== null && !win.isDestroyed()) win.webContents.send(DEBUG_CHANNELS.command, command);
    },

    onIntent(fn): Unsubscribe {
      intentListeners.add(fn);
      return () => intentListeners.delete(fn);
    },

    onClosed(fn): Unsubscribe {
      closedListeners.add(fn);
      return () => closedListeners.delete(fn);
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      ipcMain.removeListener(DEBUG_CHANNELS.intent, onIntentMessage);
      intentListeners.clear();
      closedListeners.clear();
      if (win !== null && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

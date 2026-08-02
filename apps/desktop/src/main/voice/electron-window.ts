/**
 * The only file in the voice component that imports Electron.
 *
 * Every property below differs from the overlay's window for a reason, and the differences are the
 * whole of ADR-0010. The overlay is transparent, click-through, focusable-never and re-placed on
 * every display change; this one is *offscreen* and has no visual properties at all, because its
 * only output is sound.
 *
 * ## The two settings that would break it silently
 *
 * **`backgroundThrottling: false`.** Chromium throttles timers in a window that is not visible, and
 * this window is *never* visible. The level pump is a `setInterval` and the commit grace is a
 * `setTimeout`; throttled, the bars stop moving and every turn waits the full 400 ms grace. The
 * overlay sets this too, for a different reason, and here it is load-bearing rather than an
 * optimisation.
 *
 * **`sandbox: true` with `nodeIntegration: false`.** Kept, and the reason the renderer is bundled
 * (ADR-0034) rather than resolving `@riki/audio` through Node. The alternative — `sandbox: false`
 * so the preload can require workspace packages — is a thing that gets copied to the next window by
 * someone who has not read that ADR.
 *
 * ## Microphone permission
 *
 * `setPermissionRequestHandler` on this window's session grants `media` and refuses everything
 * else. Without a handler Electron denies `getUserMedia` outright and the failure surfaces as
 * `NotAllowedError` — indistinguishable, from the renderer, from the player having said no. The
 * *operating system's* permission is separate and is what the player actually sees on macOS.
 */

import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';

import { decodeVoiceUpdate } from '@riki/protocol';
import type { VoiceDirective, VoiceUpdate } from '@riki/protocol';

import { VOICE_CHANNELS } from '../../shared/voice-channels.js';
import type { VoiceWindow, VoiceWindowFactory } from './contracts.js';

export interface ElectronVoiceWindowOptions {
  /** Absolute path to the compiled voice preload (`dist/preload/voice.js`). */
  readonly preloadPath: string;
  /** Absolute path to the voice renderer's document. */
  readonly entryPath: string;
}

export function createElectronVoiceWindowFactory(
  options: ElectronVoiceWindowOptions,
): VoiceWindowFactory {
  return { create: () => createElectronVoiceWindow(options) };
}

function createElectronVoiceWindow(options: ElectronVoiceWindowOptions): VoiceWindow {
  const win = new BrowserWindow({
    show: false,
    // Not merely hidden: this window has no reason to ever be composited, and an offscreen one
    // cannot be revealed by a stray `show()` somewhere else in the app.
    x: -10_000,
    y: -10_000,
    width: 1,
    height: 1,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Load-bearing, not an optimisation — see the header.
      backgroundThrottling: false,
      preload: options.preloadPath,
    },
  });

  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    // `media` is `getUserMedia`. Everything else — notifications, geolocation, midi, display
    // capture — is refused: this window has one job and nothing it loads should be asking.
    callback(permission === 'media');
  });

  const updateListeners = new Set<(update: VoiceUpdate) => void>();
  const problemListeners = new Set<(detail: string) => void>();

  const onIpc = (event: IpcMainEvent, raw: unknown): void => {
    // Every window in the app shares `ipcMain`, so without this the overlay renderer could send
    // on the voice channel. `webContents.id` is the only thing that makes the sender an identity.
    if (event.sender.id !== win.webContents.id) return;

    const decoded = decodeVoiceUpdate(raw);
    if (!decoded.ok) {
      const detail =
        decoded.reason === 'version'
          ? `voice renderer speaks protocol v${String(decoded.theirs)}`
          : decoded.detail;
      for (const listener of [...problemListeners]) listener(detail);
      return;
    }
    for (const listener of [...updateListeners]) listener(decoded.message);
  };

  ipcMain.on(VOICE_CHANNELS.update, onIpc);

  let closed = false;
  win.on('closed', () => {
    closed = true;
  });

  void win.loadFile(options.entryPath);

  return {
    send(directive: VoiceDirective): void {
      if (closed || win.isDestroyed()) return;
      win.webContents.send(VOICE_CHANNELS.directive, directive);
    },

    onUpdate(listener): () => void {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },

    onProblem(listener): () => void {
      problemListeners.add(listener);
      return () => problemListeners.delete(listener);
    },

    close(): void {
      ipcMain.off(VOICE_CHANNELS.update, onIpc);
      updateListeners.clear();
      problemListeners.clear();
      if (!closed && !win.isDestroyed()) win.destroy();
      closed = true;
    },
  };
}

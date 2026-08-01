/**
 * Electron main process: app lifecycle, and the Electron-shaped ports the shell takes.
 *
 * Keep this thin. Business logic belongs in packages/ where it is testable without a window
 * (REPO_SKELETON.md §2.1), and everything that is not literally an Electron API call belongs in
 * `shell/`, which runs in Vitest. This file has one job that nothing else can do: turn Electron's
 * lifecycle into `RikiShell.start()` and `RikiShell.stop()`, exactly once each.
 *
 * ## The four lifecycle decisions, and why each is what it is
 *
 * - **Single instance.** Two Rikis means two processes binding port 53101 — the second fails,
 *   silently, and the player has a tray icon that never sees a game. `requestSingleInstanceLock`
 *   makes the second launch a no-op instead.
 * - **`window-all-closed` does not quit.** Riki is a tray application with no primary window; the
 *   overlay is created hidden and stays hidden. Electron's default would quit the app the first
 *   time the overlay was hidden on a non-macOS platform, which is every time.
 * - **No dock icon on macOS.** The tray is the control surface (ui-design.md §2.2). A dock icon
 *   for an app with no window is a promise of a window.
 * - **`before-quit` awaits `stop()`.** The sidecar is a child process and durable memory is
 *   batched: quitting without draining both leaves an orphan and loses the match's memory. The
 *   quit is deferred exactly once and then allowed through.
 *
 * ## What this does not do
 *
 * It does not write `gamestate_integration_riki.cfg`. `tools/setup-gsi-cfg` is named in
 * `.env.example` and does not exist, so **GSI will not deliver anything until somebody writes that
 * cfg by hand** with the port and token from the app's data directory. That is the one manual step
 * between this file and a live game, and `docs/runbooks/dev-setup.md` is where it belongs.
 */

import { app } from 'electron';
import { performance } from 'node:perf_hooks';

import { systemTimers } from '@riki/context';
import { DEFAULT_MAX_BODY_BYTES, createGsiServer } from '@riki/gsi';
import { createConsoleLogTailer, defaultMatchers } from '@riki/log-tail';
import type { Clock as WorldClock } from '@riki/world-model';

import type { Millis } from '../shared/overlay.js';
import { loadOrCreateGsiToken, loadSettings, resolvePaths } from './bootstrap.js';
import { createElectronOverlayWindowFactory } from './overlay/electron-window.js';
import type { Clock as UiClock } from './session/contracts.js';
import type { TimerId } from './session/types.js';
import { gsiRegistration, logTailRegistration } from './state/index.js';
import { createNodeChildProcessPort } from './sidecar/index.js';
import { createElectronTray } from './tray/index.js';
import { createElectronKeySource } from './trigger/index.js';
import type { RikiShell, ShellConfig } from './shell/index.js';
import { createRikiShell, resolveShellConfig } from './shell/index.js';

/**
 * The one clock, in Electron's terms.
 *
 * `performance.now()` and not `Date.now()`: `Millis` and `MonoMs` are both documented as monotonic,
 * every staleness policy in `packages/world-model` subtracts two of them, and a wall clock that
 * steps backwards over an NTP correction or a DST boundary would make a fact briefly younger than
 * zero. `performance.now()` cannot do that.
 */
function createElectronClock(): UiClock {
  const timers = new Map<TimerId, ReturnType<typeof setTimeout>>();
  return {
    now: (): Millis => performance.now(),
    schedule(id, delayMs, fire): void {
      const existing = timers.get(id);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(
        id,
        setTimeout(
          () => {
            timers.delete(id);
            fire();
          },
          Math.max(0, delayMs),
        ),
      );
    },
    cancel(id): void {
      const handle = timers.get(id);
      if (handle === undefined) return;
      clearTimeout(handle);
      timers.delete(id);
    },
    cancelAll(): void {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    },
  };
}

function buildShell(): RikiShell {
  const appRoot = app.getAppPath();
  const dataDir = app.getPath('userData');
  const paths = resolvePaths(appRoot);

  const config: ShellConfig = resolveShellConfig({
    dataDir,
    gsiToken: loadOrCreateGsiToken(dataDir),
    ...loadSettings(dataDir),
  });

  const clock = createElectronClock();

  return createRikiShell({
    config,
    clock,
    timers: systemTimers,
    platform: process.platform,
    processes: createNodeChildProcessPort(),

    sources: {
      gsi: (cfg: ShellConfig, worldClock: WorldClock) =>
        gsiRegistration(
          createGsiServer({
            port: cfg.gsi.port,
            token: cfg.gsi.token,
            clock: worldClock,
            maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
          }),
        ),
      logTail: (cfg: ShellConfig, worldClock: WorldClock) =>
        cfg.logTail.path === null
          ? null
          : logTailRegistration(
              createConsoleLogTailer({
                path: cfg.logTail.path,
                matchers: defaultMatchers(),
                clock: worldClock,
                pollMs: cfg.logTail.pollMs,
              }),
            ),
    },

    windowFactory: createElectronOverlayWindowFactory({
      preloadPath: paths.preload,
      entryPath: paths.overlayEntry,
    }),
    tray: createElectronTray({ iconDir: paths.trayIcons }),
    keys: createElectronKeySource({
      accelerator: config.hotkey.talk,
      now: () => clock.now(),
    }),
  });
}

/** What the data directory and the tray tooltip are named after. Not the npm package name. */
const APP_NAME = 'Riki';

let shell: RikiShell | null = null;
let quitting = false;

/**
 * Startup failed. Say so on stderr and exit non-zero.
 *
 * `process.stderr.write` rather than `console.error`: the `no-console` lint rule confines logging
 * to `packages/telemetry` so that redaction runs before any sink, and that rule is right. This is
 * the one place it cannot be honoured — the app is dying *because* nothing is wired, so the
 * telemetry sink is exactly what does not exist — and the alternative is a process that vanishes
 * with no explanation. The message is an `Error`'s own text and carries no config value.
 */
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Riki failed to start: ${message}\n`);
  app.exit(1);
}

// Before any `getPath('userData')`. Electron derives the data directory from the app name, which
// defaults to `package.json`'s — so without this the token, the settings and the durable memory
// land in `~/.config/@riki/desktop`, a *nested* directory named after a scope. Verified by running
// it: that is exactly where the first run put them.
app.setName(APP_NAME);

if (!app.requestSingleInstanceLock()) {
  // A second launch. The lock holder gets `second-instance`; this process has nothing to do and
  // must not run any of the below — `app.quit()` alone would still let `whenReady` fire.
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // Nothing to focus: there is no primary window. Silence is the correct response, and it is
    // recorded here so the next person does not add a `show()` for a window that stays hidden.
  });

  // A tray application. The overlay window is created hidden and hidden again after every
  // interaction, so Electron's default would quit on the first hide outside macOS.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', (event) => {
    if (quitting || shell === null) return;
    quitting = true;
    // Deferred exactly once. The sidecar is a child process and durable memory is batched; both
    // need draining, and `stop()` is the only thing that does it.
    event.preventDefault();
    void shell.stop().finally(() => {
      shell = null;
      app.quit();
    });
  });

  void app.whenReady().then(
    async () => {
      // The tray is the control surface (ui-design.md §2.2); a dock icon for an app with no window
      // is a promise of a window. macOS only — `app.dock` is undefined elsewhere.
      app.dock?.hide();

      try {
        shell = buildShell();
        shell.onQuitRequested(() => {
          app.quit();
        });
        await shell.start();
      } catch (error: unknown) {
        // ⚠ This `catch` is not defensive padding. `.then(onFulfilled, onRejected)` routes only
        // the *original* promise's rejection to the second handler — a throw inside the first
        // becomes an unhandled rejection, and Electron's default for one of those is to carry on
        // with a half-started app and no message. With `packages/telemetry` still a skeleton there
        // is nowhere to log it either, so a failed start would present as a tray icon that never
        // sees a game. Dying is the honest answer until there is a sink to say why.
        fail(error);
      }
    },
    (error: unknown) => {
      // `whenReady` rejecting means Electron itself failed to initialise.
      fail(error);
    },
  );
}

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
import type { CoachModel, LlmCoachConfig } from '@riki/coach';
import { createOpenAiCoachModel } from '@riki/coach';
import { loadConfig, voiceEnabled } from '@riki/config';
import { createFakeVisionSidecar, defaultVisionScript } from '@riki/protocol/testing';

import {
  loadOrCreateGsiToken,
  loadOrCreateInstallId,
  loadSettings,
  resolvePaths,
  saveSettings,
} from './bootstrap.js';
import {
  createElectronDebugWindowFactory,
  createMockStateLibrary,
  nodeMockStateFiles,
} from './debug/index.js';
import { createElectronOverlayWindowFactory } from './overlay/electron-window.js';
import type { Clock as UiClock } from './session/contracts.js';
import type { TimerId } from './session/types.js';
import { gsiRegistration, logTailRegistration } from './state/index.js';
import { createNodeChildProcessPort } from './sidecar/index.js';
import { createElectronTray } from './tray/index.js';
import { createElectronKeySource } from './trigger/index.js';
import { createElectronVoiceWindowFactory, createVoiceSession } from './voice/index.js';
import type { MatchScopedSession } from './shell/index.js';
import type { RikiShell, ShellConfig } from './shell/index.js';
import { createRikiShell } from './shell/index.js';

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

  // Every layer, in one call, from the one module in the repo permitted to read the environment
  // (REPO_SKELETON.md §6.2): CLI flags, `RIKI_*`, `.env`, `settings.json`, defaults. It is
  // validated and it throws on the first bad key — which is why it is inside `buildShell` and
  // therefore inside the `try` in `whenReady`. A `ConfigError` reaches `fail()` and the app exits
  // naming the variable, rather than half-booting with a broken setting and discovering it ten
  // minutes into a game (REPO_SKELETON.md §7).
  //
  // The coach *mode* is not among the things the environment can set, deliberately: a UI control a
  // stale shell variable can override is not a control (`packages/config`'s `keys.ts`).
  //
  // `process.argv` is Electron's, so unrecognised switches are ignored, and the upward search for
  // `.env` finds the repo root from `apps/desktop` in a dev run.
  const config: ShellConfig = loadConfig({
    dataDir,
    gsiToken: loadOrCreateGsiToken(dataDir),
    argv: process.argv.slice(1),
  });

  const clock = createElectronClock();
  const apiKey = config.openai.apiKey;

  /**
   * The one line that decides whether Riki speaks.
   *
   * With no `RIKI_OPENAI_API_KEY` the app boots with voice disabled and says so (ADR-0006) — which
   * is the mode every test, every fixture run and CI are in — and the silent stand-in keeps the
   * whole coaching pipeline observable through the ledger and the counters. With a key, the same
   * pipeline ends in a hidden renderer that actually talks.
   *
   * `createVoiceSession` is handed the key by injection and never reads the environment; it is the
   * only thing in the process that touches `ClientSecretBroker`, and what crosses the preload
   * bridge is an ephemeral secret (ADR-0015).
   */
  const session: MatchScopedSession | undefined = voiceEnabled(config)
    ? createVoiceSession({
        config,
        windows: createElectronVoiceWindowFactory({
          preloadPath: paths.voicePreload,
          entryPath: paths.voiceEntry,
        }),
        clock: { now: () => clock.now() as never },
        safetyIdentifier: loadOrCreateInstallId(dataDir),
        // Node 22's global. Narrowed to `FetchLike` by the port, so `packages/realtime` still
        // names no vendor and is still testable with a stub.
        fetch: (url, init) => fetch(url, init),
        // ⚠ Every one of these is a no-op, and it is the largest remaining gap in this path.
        // `packages/telemetry` still exports `{}` and `console.*` is confined to it — so a failed
        // mint, a bridge decode error and a self-interruption all happen silently in a release
        // build. The *events* reach the chip; the counters reach nothing. One object literal once
        // that package exists.
        telemetry: {
          speaking: () => undefined,
          fault: () => undefined,
          state: () => undefined,
          bridgeProblem: () => undefined,
        },
      })
    : undefined;

  return createRikiShell({
    config,
    ...(session === undefined ? {} : { session }),
    clock,
    timers: systemTimers,
    platform: process.platform,

    /**
     * The sidecar, or a fake standing where it would be.
     *
     * `RIKI_FAKE_VISION=1` is the only configuration in which the vision leg of the loop runs
     * anywhere today: `crates/riki-vision` can capture on macOS alone and that backend has never
     * been executed (ADR-0033), while its portable `--backend replay` has no atlas and so reports
     * region digests and no facts. The fake speaks the same protocol over the same
     * `ChildProcessPort`, so everything above this line — the handshake, the codec, supervision and
     * restart, fusion, the trigger ladder — is the production path either way (ADR-0035).
     *
     * `loop` because a sidecar that goes permanently silent after a minute is one the health poll
     * reports as `degraded` for the rest of the session, and `speed: 1` because a dev run wants the
     * recorded 5 Hz rather than everything at once. A test builds its own with `speed: 0` and turns
     * the crank itself.
     */
    processes: config.vision.fake
      ? createFakeVisionSidecar({ script: defaultVisionScript(), speed: 1, loop: true })
      : createNodeChildProcessPort(),

    // Supplied only when there is a key to build it with. `undefined` is what makes the tray's
    // Coach row report the LLM coach as unavailable rather than offering a mode that would start a
    // match and then say nothing all game.
    ...(apiKey === null
      ? {}
      : {
          coachModel: (coachConfig: LlmCoachConfig): CoachModel =>
            createOpenAiCoachModel({ apiKey, config: coachConfig }),
        }),

    // What makes the tray's Coach row a setting rather than a gesture. The shell does no I/O, so it
    // announces the change and this writes it.
    onCoachModeChanged: (mode) => {
      // Read-modify-write through `bootstrap.ts` rather than from `config`: the resolved value has
      // already had the environment and the defaults folded into it, so writing it back would
      // persist settings the player never chose.
      saveSettings(dataDir, { coach: { ...loadSettings(dataDir).coach, mode } });
    },

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

    // Constructed unconditionally and consulted only when `config.debug.enabled` — the factory
    // creates no window until something calls `open()`, so an unused one costs a closure.
    debugWindows: createElectronDebugWindowFactory({
      preloadPath: paths.debugPreload,
      entryPath: paths.debugEntry,
    }),

    // The inspector's rehearsal library (ADR-0038), also consulted only when the flag is on. Built
    // here rather than in the shell because it is a directory read and `shell/index.ts` does no
    // I/O — the same split as `createFileMemoryStore`. A missing directory is an empty dropdown,
    // which is what a packaged build gets.
    mockStates: createMockStateLibrary({ files: nodeMockStateFiles(paths.mockStates) }),
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

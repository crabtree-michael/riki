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
 * - **`before-quit` awaits `stop()`.** The sidecar is a child process: quitting without draining it
 *   leaves an orphan. The quit is deferred exactly once and then allowed through.
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
import { loadConfig, voiceEnabled } from '@riki/config';
import { createFakeVisionSidecar, defaultVisionScript } from '@riki/protocol/testing';
import type { ToolDispatcher } from '@riki/realtime';

import { loadOrCreateGsiToken, loadOrCreateInstallId, resolvePaths } from './bootstrap.js';
import { createElectronDebugWindowFactory } from './debug/index.js';
import type { DebugHub } from './debug/index.js';
import { createElectronOverlayWindowFactory } from './overlay/electron-window.js';
import type { Clock as UiClock } from './session/contracts.js';
import type { TimerId } from './session/types.js';
import { gsiRegistration, logTailRegistration } from './state/index.js';
import { createNodeChildProcessPort } from './sidecar/index.js';
import { createElectronTray } from './tray/index.js';
import { createElectronKeySource } from './trigger/index.js';
import { createElectronVoiceWindowFactory, createVoiceSession } from './voice/index.js';
import type { VoiceSessionTelemetry } from './voice/index.js';
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
  const voiceTrace = createVoiceTrace(() => clock.now());
  const voiceTools = createToolPort();

  /**
   * The one line that decides whether Riki speaks.
   *
   * With no `RIKI_OPENAI_API_KEY` the app boots with voice disabled and says so (ADR-0006) — which
   * is the mode every test, every fixture run and CI are in — and the silent stand-in keeps the
   * whole turn path observable through the inspector. With a key, the same path ends in a hidden
   * renderer that actually talks.
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
        // What renewal wakes up on (ADR-0045). Without it the 60-minute cap is only ever handled
        // after the fact, and a failed reopen has nothing to retry with — see `VoiceSessionDeps`.
        timers: systemTimers,
        safetyIdentifier: loadOrCreateInstallId(dataDir),
        // Node 22's global. Narrowed to `FetchLike` by the port, so `packages/realtime` still
        // names no vendor and is still testable with a stub.
        fetch: (url, init) => fetch(url, init),
        // Forwarded into the inspector's trace when there is one, dropped when there is not
        // (ADR-0038). Until `packages/telemetry` lands this is the only place a session fault is
        // visible at all — these four were no-ops until 2026-08-04, which is why a mint that
        // returned an unusable session id cost a day to find: main sent the directive, the renderer
        // rejected it as unreadable, and nothing anywhere said so.
        telemetry: voiceTrace.sink,
        /**
         * What answers the model's five tools (ADR-0042, T12).
         *
         * Passing it here is what makes `voice.session.open` carry `tools: true`, which is what
         * makes the renderer advertise the manifest at all (ADR-0049). Before this line existed,
         * every live session went out with `tools: []` and Riki knew only the ~300 tokens of
         * snapshot — which is the bug a player reported on 2026-08-09.
         *
         * Late-bound, for the same construction order `voiceTrace` works around: the real
         * dispatcher reads the world model, the world model belongs to the shell, and the shell
         * needs the session. Attached six lines below, before `start()` and therefore long before
         * a match can open a session.
         */
        tools: voiceTools.port,
      })
    : undefined;

  const shell = createRikiShell({
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
     * restart, fusion — is the production path either way (ADR-0035).
     *
     * `loop` because a sidecar that goes permanently silent after a minute is one the health poll
     * reports as `degraded` for the rest of the session, and `speed: 1` because a dev run wants the
     * recorded 5 Hz rather than everything at once. A test builds its own with `speed: 0` and turns
     * the crank itself.
     */
    processes: config.vision.fake
      ? createFakeVisionSidecar({ script: defaultVisionScript(), speed: 1, loop: true })
      : createNodeChildProcessPort(),

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
  });

  // After construction, because the hub is the shell's and the session is built before it. Null
  // with the flag off, which puts the sink back to dropping everything.
  voiceTrace.attach(shell.debug?.hub ?? null);
  // Same knot, same answer: the dispatcher reads the world model and the shell owns it.
  voiceTools.attach(shell.tools);
  return shell;
}

/**
 * The tool dispatcher, pointed at the shell's once there is one.
 *
 * The mirror of `createVoiceTrace` below, and it exists for the same reason: `createVoiceSession`
 * takes its dependencies at construction, the world model belongs to the shell, and the shell needs
 * the session. A late-bound port is the small half of that knot.
 *
 * **The unattached answer is an `unknown`, not a throw.** The window between construction and
 * `attach` is a few statements long and no session can exist inside it, so this should be
 * unreachable — but "should be unreachable" is not a thing to assert inside a response that is
 * already being spoken (ADR-0049). If the order ever changes, Riki says it cannot see the game
 * rather than losing the sentence, and the reason names this file.
 */
function createToolPort(): { readonly port: ToolDispatcher; attach(tools: ToolDispatcher): void } {
  let attached: ToolDispatcher | null = null;

  return {
    port: {
      call: async (name, args) => {
        if (attached === null) {
          return Promise.resolve({
            unknown: `Riki's world model was not attached when \`${name}\` was called — see buildShell in main/index.ts`,
          } as never);
        }
        return attached.call(name, args);
      },
    },
    attach(tools: ToolDispatcher): void {
      attached = tools;
    },
  };
}

/**
 * The voice session's telemetry, pointed at the inspector's hub once there is one (ADR-0038).
 *
 * Late-bound because of a construction order that is not worth inverting: `createVoiceSession` needs
 * its telemetry at construction, the hub belongs to the shell, and the shell needs the session. A
 * mutable sink is the small half of that knot — everything it forwards is a string, and with no hub
 * attached it is exactly the four no-ops it replaced.
 *
 * **The clock is main's, injected, and never `Date.now()`.** A frame's ages are computed against
 * `DebugFrame.at`, which comes from the same monotonic clock; a step stamped with wall-clock epoch
 * milliseconds subtracts to a large negative number and renders as `0ms ago` on every row. Measured
 * on 2026-08-04, in a screenshot, after shipping it — the rows were in the right order and every
 * age was a lie.
 */
function createVoiceTrace(now: () => number): {
  readonly sink: VoiceSessionTelemetry;
  attach(hub: DebugHub | null): void;
} {
  let hub: DebugHub | null = null;

  const record = (stage: string, message: string): void => {
    hub?.recordTrace(stage, message, now());
  };

  return {
    sink: {
      speaking: (turnId, scenario, chars) => {
        record(
          'session',
          scenario
            ? `speakNow ${turnId} sent — ${String(chars)} chars`
            : `turn ${turnId} closed, ${String(chars)} chars`,
        );
      },
      // The line that would have named the bug on 2026-08-04's first run.
      fault: (kind, message) => {
        record('fault', `voice ${kind}: ${message}`);
        hub?.recordProblem('renderer', `voice ${kind}: ${message}`, now());
      },
      state: (next) => {
        record('session', `session state → ${next}`);
      },
      /**
       * A renewal, in the Trace panel rather than in Problems (ADR-0045).
       *
       * It belongs in the trace because it is *progress* — the session reaching the end of its
       * 60-minute life and being replaced — and the player is meant never to notice it. Only
       * `gaveUp` is also a problem, and by then the player has been told too.
       */
      renewal: (phase, reason, detail) => {
        record('session', `renewal ${phase} (${reason}): ${detail}`);
        if (phase === 'gaveUp') {
          hub?.recordProblem('renderer', `voice renewal gave up: ${detail}`, now());
        }
      },
      bridgeProblem: (detail) => {
        record('fault', `voice bridge: ${detail}`);
        hub?.recordProblem('renderer', `voice bridge: ${detail}`, now());
      },
      /**
       * A tool call that produced no fact (ADR-0049).
       *
       * Recorded on the hub as a call *and* its refusal, because that is the only way it reaches
       * the T9 panel: these are exactly the failures `observeToolCalls` cannot see — the name was
       * not one of the five, or the arguments did not parse, so nothing was ever dispatched for the
       * decorator to wrap.
       *
       * It is a Problem as well as a Trace line, and that is the difference between this and
       * `renewal` above. A renewal is progress; a refused call means the model just answered a
       * question with less than it could have, and nothing about the sentence it spoke will have
       * sounded wrong.
       */
      toolRejected: (name, reason) => {
        record('tool', `refused ${name}: ${reason}`);
        const seq = hub?.recordToolCall({ name, args: '—', at: now() });
        if (seq !== undefined) {
          hub?.recordToolResult(seq, { status: 'refused', result: reason, at: now() });
        }
        hub?.recordProblem('renderer', `tool call ${name} refused: ${reason}`, now());
      },
    },
    attach(next: DebugHub | null): void {
      hub = next;
    },
  };
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
    // Deferred exactly once. The sidecar is a child process and needs draining, and `stop()` is the
    // only thing that does it.
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

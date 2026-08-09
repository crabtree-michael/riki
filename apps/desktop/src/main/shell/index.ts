/**
 * The shell — everything the Electron app is, minus Electron.
 *
 * `apps/desktop/src/main/index.ts` is nine lines of `app.whenReady()` and a handful of constructor
 * calls; this is where they are all wired together. The split exists for one reason and it is the
 * reason the whole repository is shaped the way it is: **the composition root has to be runnable
 * in Vitest.** Nothing in this file imports `electron` — the tray, the overlay window, the hotkey
 * and the child-process spawner all arrive as ports — and `shell.test.ts` drives the whole thing
 * from a GSI fixture with none of them.
 *
 * ## What is wired
 *
 * ```
 *   GsiServer ──► ObservationBus ──► WorldModelStore ──► SnapshotSource
 *                                                              │ snapshot text
 *                                                              ▼
 *   TriggerPump (hotkey) ──► SessionRuntime ──► TurnAgent ──► VoiceSessionPort
 *                                   │                              │ VoiceEvent
 *                                   └──► OverlayPresenter, Tray ◄──┘
 * ```
 *
 * Read the top row right to left and it is the whole product: the player presses a key, the world
 * model is rendered as ~300 tokens of text, and the question and the text go to the model together.
 * ADR-0042 deleted what used to sit in the middle — detectors, salience, thirteen gates, a coaching
 * brief, a conversation ledger and a second language model deciding whether to interrupt — on the
 * grounds that a coach who never interrupts you cannot interrupt you wrongly.
 *
 * ## Two lifetimes, not one
 *
 * The state subsystem, the overlay, the tray, the hotkey and the turn agent live as long as the app.
 * **The Realtime session does not**: its instructions are frozen at `match_started` (ADR-0011) and
 * the API caps a session at 60 minutes, so it is opened on `match_started` and closed on
 * `match_ended`.
 *
 * The agent moved out of that second lifetime and into the first, which is the shape ADR-0042 made
 * possible: rendering a snapshot needs a world and nothing else — no ledger, no coaching memory, no
 * per-match preamble — so there is no per-match object left for it to belong to. It also fixes
 * something that was previously a rough edge: push-to-talk between matches now takes exactly the
 * same path as push-to-talk in one.
 *
 * ## Speech
 *
 * `MatchScopedSession` is the seam, and it has two implementations. `main/voice/`'s
 * `createVoiceSession` opens a real Realtime session in a hidden renderer (ADR-0010);
 * `silent-session.ts` fakes the timing and opens nothing. `main/index.ts` picks on whether
 * `packages/config` found an API key, and **nothing else in this file changes between them** —
 * which is the property that made the stand-in worth writing and is worth keeping.
 *
 * ## The inspector
 *
 * When `config.debug.enabled`, one more thing is wired: `main/debug/`, which observes every stage of
 * the diagram above and pushes it to a dev-only window. It is composed rather than injected — the
 * `SnapshotSource` is decorated on its way into the agent, and the decorator returns its delegate's
 * value unchanged. With the flag off nothing above changes in any way, which is the property the
 * whole component is built around (ADR-0032).
 *
 * It can also run a scenario (ADR-0039): `scenario.match` pushes a scripted GSI sequence through our
 * own server, and `scenario.speak` renders the current snapshot straight at the session port to
 * isolate the voice leg. The gate, trigger, counter, control and rehearsal panels are gone with the
 * engine they observed; their replacement is a per-turn tool trace, which is T9 of the migration.
 */

import type { MatchId, Timers, TurnId } from '@riki/context';
import type { MatchLifecycleEvent } from '@riki/gsi';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ToolDispatcher } from '@riki/realtime';
import type { Clock as WorldClock, MonoMs } from '@riki/world-model';
import { createFileRecordSinks, createStalenessPolicy, matchFileName } from '@riki/world-model';

import type { Millis, Unsubscribe } from '../../shared/overlay.js';
import type { SnapshotSource, TurnAgent, VoiceSessionPort } from '../agent/index.js';
import {
  createSnapshotSource,
  createTurnAgent,
  createWorldToolDispatcher,
  toContextReader,
} from '../agent/index.js';
import { createVoiceBridge } from '../adapters/voice.js';
import type {
  DebugActionPort,
  DebugSessionInput,
  DebugSurface,
  DebugWindowFactory,
} from '../debug/index.js';
import {
  createDebugActions,
  createDebugHub,
  createDebugSurface,
  observeSnapshots,
  observeToolCalls,
  projectWorld,
  runMatchScenario,
  withDebugTelemetry,
} from '../debug/index.js';
import type { OverlaySurface } from '../overlay/index.js';
import { createOverlaySurface } from '../overlay/index.js';
import type { OverlayWindowFactory } from '../overlay/window-port.js';
import type { Clock as UiClock, SessionRuntime } from '../session/index.js';
import { DEFAULT_ENVIRONMENT, createSessionRuntime, machine } from '../session/index.js';
import type { MachineEnvironment } from '../session/types.js';
import type { BusStats, SourceRegistration, StateSubsystemWithExtras } from '../state/index.js';
import { SIDECAR_RESTART, buildStateSubsystem } from '../state/index.js';
import { PROTOCOL_VERSION } from '@riki/protocol';
import {
  DEFAULT_CAPTURE_CONFIG,
  createProtocolCodec,
  createSidecarSource,
} from '../sidecar/index.js';
import type { ChildProcessPort } from '../sidecar/index.js';
import type { TrayController, TraySurface } from '../tray/index.js';
import { createTrayController } from '../tray/index.js';
import type { KeySource } from '../trigger/index.js';
import { createGestureRecognizer, createTriggerPump } from '../trigger/index.js';
import type { ShellConfig } from './config.js';
import { buildSessionPrompt } from './prompt.js';
import { createSilentSession } from './silent-session.js';
import { nullTelemetry, type ShellTelemetry } from './telemetry.js';

export * from './config.js';
export { buildSessionPrompt } from './prompt.js';
export { createSilentSession, NOMINAL_SPEECH_MS } from './silent-session.js';
export type { SilentSession, SilentSessionDeps } from './silent-session.js';
export { nullTelemetry } from './telemetry.js';
export type { ShellTelemetry } from './telemetry.js';

/** How often health is polled and pushed to the tray. §8.1 wants a timer, not a subscription. */
export const HEALTH_POLL_MS = 2_000;

/**
 * Sources arrive as a factory rather than as values so the shell can decide *whether* to build
 * them from config, and so a test can substitute `FakeGsiSource` without the shell knowing.
 */
export interface SourceFactory {
  /** The GSI listener, or a fixture replay. Always present — it is the only mandatory source. */
  gsi(config: ShellConfig, clock: WorldClock): SourceRegistration;
  /** Dota's `console.log`. Absent when `config.logTail.path` is null. */
  logTail?(config: ShellConfig, clock: WorldClock): SourceRegistration | null;
}

export interface ShellDeps {
  readonly config: ShellConfig;
  /**
   * The **one** clock. Everything else derives from it, deliberately: two clocks means two answers
   * to "how old is this fact", and the whole fact envelope exists to make that answer trustworthy.
   */
  readonly clock: UiClock;
  readonly timers: Timers;
  readonly sources: SourceFactory;
  readonly windowFactory: OverlayWindowFactory;
  readonly tray: TraySurface;
  readonly keys: KeySource;
  /** Only consulted when `config.vision.enabled` and a binary path is set. */
  readonly processes?: ChildProcessPort;
  readonly platform: string;
  readonly telemetry?: ShellTelemetry;
  /**
   * Defaults to `createSilentSession`.
   *
   * `main/voice/`'s `createVoiceSession` is the real one, and it is the *only* thing that changes
   * between a Riki that speaks and one that does not — every stage above this line is identical.
   * `index.ts` chooses between them on whether `packages/config` found an API key.
   */
  readonly session?: MatchScopedSession;
  readonly environment?: MachineEnvironment;
  /**
   * Only consulted when `config.debug.enabled`.
   *
   * Absent in `shell.test.ts` even with the flag on, which is deliberate: everything the inspector
   * *collects* is testable with no window, and the window itself is Tier 5's business.
   */
  readonly debugWindows?: DebugWindowFactory;
}

/**
 * A `VoiceSessionPort` with a match lifetime.
 *
 * The agent's port is deliberately narrower — open a turn, end it, abort, hear the events — and it
 * has no business knowing that a Realtime session exists, let alone when one opens. But *something*
 * has to open one, and the shell is what knows when a match starts: the instructions are frozen at
 * `match_started` (ADR-0011). So the two extra methods live here rather than in
 * `agent/contracts.ts`.
 */
export interface MatchScopedSession extends VoiceSessionPort {
  /** The session instructions, already assembled. Opening is best-effort: a failure is a fault. */
  openMatch(instructions: string): Promise<void>;
  closeMatch(reason: string): Promise<void>;
}

export interface RikiShell {
  readonly state: StateSubsystemWithExtras;
  readonly runtime: SessionRuntime;
  readonly overlay: OverlaySurface;
  readonly trayController: TrayController;
  readonly session: MatchScopedSession;
  /** App-lifetime. See "Two lifetimes" above for why this is no longer per match. */
  readonly agent: TurnAgent;
  /**
   * What answers the model's five tools, decorated for the inspector when it is on.
   *
   * Exposed because of a construction order that is not worth inverting: `createVoiceSession` needs
   * its dependencies before the shell exists, and this needs the world model, which the shell
   * builds. `main/index.ts` hands the session a late-bound port and points it here — the same knot
   * `createVoiceTrace` solves next door, and the same shape of answer.
   */
  readonly tools: ToolDispatcher;
  /** The match a session has been opened for, or null between games. */
  readonly matchId: MatchId | null;
  /** Null unless `config.debug.enabled`. The inspector, and the hub behind it. */
  readonly debug: DebugSurface | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The tray's Quit row and the app's own quit path both land here. */
  onQuitRequested(listener: () => void): Unsubscribe;
}

export function createRikiShell(deps: ShellDeps): RikiShell {
  const { config, clock, timers } = deps;

  // One clock, two vocabularies. `Millis` and `MonoMs` are the same monotonic number; the brand is
  // what stops a wall-clock date being passed where an uptime is expected.
  const worldClock: WorldClock = { now: (): MonoMs => clock.now() as MonoMs };
  const staleness = createStalenessPolicy();

  // ---------------------------------------------------------------------------------------------
  // The inspector, if it was asked for
  // ---------------------------------------------------------------------------------------------
  //
  // Built first, because two of the things below are *decorated* by it rather than merely watched:
  // the telemetry sink every subsystem is handed, and the snapshot source the agent takes.
  // Everything else it sees, it subscribes to.

  const debugHub = config.debug.enabled ? createDebugHub() : null;

  const telemetry: ShellTelemetry =
    debugHub === null
      ? (deps.telemetry ?? nullTelemetry())
      : withDebugTelemetry({
          hub: debugHub,
          delegate: deps.telemetry ?? nullTelemetry(),
          now: () => clock.now(),
        });

  /** Every trace line goes through here, so `debug.enabled` off costs one null check (ADR-0039). */
  function trace(stage: string, message: string): void {
    debugHub?.recordTrace(stage, message, clock.now());
  }

  /**
   * The scenarios the inspector may run (ADR-0039), or null when there is no inspector.
   *
   * Both seams are asked for their availability on every frame, so the panel says *why* a row cannot
   * run rather than rendering a button that does nothing. Two closures reach forward into things
   * this function has not declared yet; neither runs until somebody clicks.
   */
  const debugActions: DebugActionPort | null =
    debugHub === null
      ? null
      : createDebugActions({
          match: {
            unavailable: () =>
              config.gsi.token === ''
                ? 'no GSI token — the server would refuse the scenario'
                : null,
            run: () =>
              runMatchScenario({
                post: postScenarioFrame,
                sleep: (ms) =>
                  new Promise<void>((resolve) => {
                    timers.after(ms, resolve);
                  }),
                trace,
              }),
          },
          speak: {
            unavailable: () => (matchId === null ? 'no session — start a match first' : null),
            run: () => speakCurrentSnapshot(),
          },
          trace,
          markRun: (startedAt) => {
            debugHub.markTraceRun(startedAt);
          },
          now: () => clock.now(),
        });

  /**
   * One scenario frame, posted at our own GSI server exactly as Dota 2 would.
   *
   * `scenarios.ts`'s header says why this is a POST rather than a shortcut into the bus. `fetch` is
   * Node 22's global; it is reached directly rather than injected because this function exists only
   * under `config.debug.enabled` and the seam it would add would be untestable in the same breath.
   */
  async function postScenarioFrame(body: Record<string, unknown>): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${String(config.gsi.port)}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, auth: { token: config.gsi.token } }),
    });
    return response.status;
  }

  /**
   * `scenario.speak` — the current snapshot, straight to the session port.
   *
   * The one thing in the product that reaches `speakNow`, and it is behind `config.debug.enabled`.
   * The chip stays hidden while it plays, because the interaction machine has no entry for a
   * response with no gesture behind it (ADR-0042) — a debug button must not be able to make the
   * overlay claim the player asked something.
   *
   * It renders through the same `SnapshotSource` the agent uses, so what it sends is exactly what a
   * real turn would be given, and the inspector's Turns panel labels it `system` rather than
   * `player`.
   */
  let scenarioTurns = 0;
  async function speakCurrentSnapshot(): Promise<void> {
    scenarioTurns += 1;
    const turnId = `scenario_${String(scenarioTurns)}` as TurnId;
    scenarioCause = true;
    const text = snapshots.render(turnId, worldClock.now()).text;
    scenarioCause = false;

    trace('turn', `scenario turn ${turnId}, ${String(text.length)} chars of snapshot`);
    await session.speakNow({ turnId, snapshotText: text });
    trace('session', `speakNow handed over for ${turnId}`);
  }

  const debug: DebugSurface | null =
    debugHub === null
      ? null
      : createDebugSurface({
          hub: debugHub,
          ...(deps.debugWindows === undefined ? {} : { windows: deps.debugWindows }),
          ...(debugActions === null ? {} : { actions: debugActions }),
          timers,
          now: () => clock.now(),
        });

  // ---------------------------------------------------------------------------------------------
  // Sources and the world model
  // ---------------------------------------------------------------------------------------------

  const registrations: SourceRegistration[] = [deps.sources.gsi(config, worldClock)];

  const logTail = deps.sources.logTail?.(config, worldClock) ?? null;
  if (logTail !== null) registrations.push(logTail);

  /**
   * Is there a sidecar to supervise?
   *
   * Three conditions and one of them is new. `vision.fake` (`RIKI_FAKE_VISION=1`) means the port
   * this shell was handed is `FakeVisionSidecar` rather than `node:child_process`, so there is no
   * binary to find and requiring a path would refuse the only configuration in which the vision
   * leg can currently run at all — macOS is the only platform with a backend and it has never been
   * executed (ADR-0033).
   *
   * Nothing else in this file branches on it, deliberately. The fake is a `ChildProcessPort`, so
   * the codec, the supervisor, the restart policy and fusion are all the production path; if the
   * shell had a second wiring for the fake, that path is what would go untested. Which port arrived
   * is `main/index.ts`'s decision and this file cannot tell.
   */
  const visionSources: string[] = [];
  const visionBinary = config.vision.fake ? 'fake-vision' : (config.vision.binaryPath ?? undefined);

  if (config.vision.enabled && visionBinary !== undefined && deps.processes !== undefined) {
    const sidecar = createSidecarSource({
      processes: deps.processes,
      request: { command: visionBinary, args: [] },
      now: () => worldClock.now(),
      // The codec is what makes the child a source rather than a process that prints things: it
      // sends the handshake, translates the sidecar's clock into ours, and routes the failures
      // dota2 §9 names to telemetry instead of letting them be silence.
      codec: createProtocolCodec({
        capture: DEFAULT_CAPTURE_CONFIG,
        onReady: (identity) => {
          telemetry.sidecarReady(identity.backend, identity.backendAvailable);
        },
        onProblem: (problem) => {
          telemetry.sidecarProblem(problem.kind, problem.fatal, problem.remedy ?? null);
        },
        onVersionMismatch: (theirs) => {
          telemetry.sidecarProtocolMismatch(theirs, PROTOCOL_VERSION);
        },
      }),
      onStderr: (line) => {
        telemetry.sidecarStderr(line);
      },
    });
    registrations.push({ source: sidecar, policy: SIDECAR_RESTART });
    visionSources.push(sidecar.id);
  }

  const state = buildStateSubsystem({
    clock: worldClock,
    timers,
    sources: registrations,
    telemetry,
    visionSources,
    // The match dataset (conversational-architecture.md §6). Local-only and never transmitted; the
    // directory is created on the first `match_started` and not before. Retention and the Steam-ID
    // hash are T10's, and they land on this path.
    recording: { openSink: createFileRecordSinks(join(config.dataDir, 'matches')) },
  });

  // ---------------------------------------------------------------------------------------------
  // The overlay, the tray, and the interaction machine
  // ---------------------------------------------------------------------------------------------

  const overlay = createOverlaySurface({
    factory: deps.windowFactory,
    clock,
    telemetry,
    platform: deps.platform,
  });

  const trayController = createTrayController(deps.tray, { debug: config.debug.enabled });
  const session: MatchScopedSession =
    deps.session ?? createSilentSession({ clock: worldClock, timers });

  const voiceCommands = createVoiceBridge();

  const runtime = createSessionRuntime(
    {
      machine,
      clock,
      overlay: overlay.presenter,
      tray: trayController,
      // Barge-in and abort. The silent session accepts both and the real one will too; the machine
      // does not learn which it is talking to.
      voice: voiceCommands.commands({
        send: (command) => {
          if (command.kind === 'abort') void session.abort();
        },
      }),
      // `packages/audio`'s earcon player needs an `AudioContext` and therefore a renderer
      // (voice-input §14 step 6 landed everything except it), and ADR-0020 already makes ducking a
      // no-op by default on the primary platform. So both sinks are honest no-ops rather than a
      // pretend implementation that would have to be found and removed later.
      audio: { earcon: () => undefined, duck: () => undefined },
      telemetry,
    },
    deps.environment ?? DEFAULT_ENVIRONMENT,
  );

  // The recognizer tracks the latch only to interpret its own next gesture; the machine returning
  // to Idle by any other path — silence, Esc, a fault — is the authoritative resync point.
  const recognizer = createGestureRecognizer({
    holdThresholdMs: (deps.environment ?? DEFAULT_ENVIRONMENT).holdThresholdMs,
  });
  const trigger = createTriggerPump({
    keys: deps.keys,
    recognizer,
    now: () => clock.now(),
    after: (ms, fn) => timers.after(ms, fn),
    dispatch: (event) => {
      runtime.dispatch({ kind: 'trigger', event });
    },
    holdThresholdMs: (deps.environment ?? DEFAULT_ENVIRONMENT).holdThresholdMs,
  });

  const disposers: Unsubscribe[] = [];

  disposers.push(
    runtime.subscribe((next) => {
      if (next.phase.kind === 'idle') trigger.resync();
    }),
  );

  // The renderer announcing itself after a crash: re-project, because the machine never lost the
  // interaction (§10.1).
  disposers.push(
    overlay.presenter.onRendererReady(() => {
      overlay.presenter.project(machine.projectChip(runtime.snapshot(), clock.now()));
    }),
  );

  disposers.push(
    overlay.presenter.onIntent((intent) => {
      if (intent.kind === 'cancel')
        runtime.dispatch({ kind: 'trigger', event: { kind: 'cancel' } });
      if (intent.kind === 'fault') telemetry.rendererFault(intent.message);
    }),
  );

  // App lifetime. The session outlives any one match and the chip has to react to it in the menu as
  // well as in a game: push-to-talk is not gated on being in a match, and never was.
  disposers.push(
    voiceCommands.attach(session, (input) => {
      runtime.dispatch(input);
    }),
  );

  // ---------------------------------------------------------------------------------------------
  // The turn agent — app lifetime, not match lifetime
  // ---------------------------------------------------------------------------------------------

  /**
   * True only for the duration of a `scenario.speak` render.
   *
   * The inspector's Turns panel has to be able to tell a button press from a question somebody
   * asked, and both go through the one `SnapshotSource`. A flag rather than a second source,
   * because a second source is a second set of options that would eventually disagree with the
   * first about what a turn is given — which is exactly what `scenario.speak` exists to rule out.
   */
  let scenarioCause = false;

  const rendered: SnapshotSource = createSnapshotSource({
    world: toContextReader(state.world, { staleness }),
    // `PrivacyConfig` is the app's settings and `PrivacyPolicy` is what a renderer takes; the two
    // are deliberately different shapes, and this is the one place they meet. Player names have no
    // setting because nothing renders one — a policy field with no producer would read as a
    // decision somebody made, and REPO_SKELETON.md §7.2 wants both defaults off either way.
    privacy: { allowChatText: config.privacy.chatEgress, allowPlayerNames: false },
  });

  /**
   * Decoration, not instrumentation: `observeSnapshots` returns the renderer's own answer and the
   * agent cannot tell the difference (ADR-0032). Everything downstream is handed this one either
   * way, so the scenario path is covered as well as the player-turn path.
   */
  const snapshots: SnapshotSource =
    debug === null
      ? rendered
      : observeSnapshots({
          delegate: rendered,
          clock: () => state.world.snapshot(worldClock.now()).clock,
          cause: () => (scenarioCause ? 'system' : 'player'),
          onRendered: (turn) => {
            debug.hub.recordTurnOpened(turn);
            trace(
              'snapshot',
              `turn ${turn.turnId} — ${String(turn.snapshotTokens)} tokens, omitted: ${
                turn.snapshotOmitted.length === 0 ? 'none' : turn.snapshotOmitted.join(', ')
              }`,
            );
          },
        });

  const agent = createTurnAgent({ snapshot: snapshots, session, clock: worldClock, telemetry });

  // ---------------------------------------------------------------------------------------------
  // The tools — the other half of what the model is given, and the half that was never connected
  // ---------------------------------------------------------------------------------------------

  /**
   * What answers `my_state`, `enemy`, `objectives`, `economy` and `world_at` (ADR-0042, T12).
   *
   * The snapshot above and this are the two things the model has, and until T12 it had only the
   * first: the session runs in the voice window, the world model runs here, and there was no
   * message between them — so `packages/realtime` was handed no dispatcher, sent `tools: []`, and a
   * live match had no tool layer at all. It was found by a player asking about their own item
   * slots, not by a test, because every layer on either side of the gap was individually correct.
   *
   * It is built here rather than beside the session in `main/index.ts` for the same reason the
   * snapshot source is: this is the only object that holds the world model, the staleness policy,
   * the recorder and the inspector's hub at once. `main/index.ts` attaches it afterwards.
   *
   * `world_at` reads the *current* match's recording, reopened per call — `TimelineTarget` measures
   * `seconds_ago` from the last line the file holds, so a timeline kept across calls answers about
   * the match's opening minutes forever while sounding current. Null between matches, which
   * `world_at` reports as "no match is being recorded" rather than as an error.
   */
  const worldTools = createWorldToolDispatcher({
    world: state.world,
    clock: worldClock,
    staleness,
    recording: async () => {
      const matchId = state.recorder?.matchId ?? null;
      if (matchId === null) return null;
      try {
        return await readFile(join(config.dataDir, 'matches', matchFileName(matchId)), 'utf8');
      } catch {
        // A recording that has not been flushed to disk yet, or a directory the app cannot read.
        // Both are "there is no past to look at", which is a sentence the model can say — and much
        // better than a rejected promise inside a response that is already being spoken.
        return null;
      }
    },
  });

  /**
   * Decoration again, and the reason the T9 trace panel has anything in it.
   *
   * `observeToolCalls` records the call *before* dispatching and re-throws whatever the delegate
   * throws, so the app behaves identically with the inspector off (ADR-0032) and a dispatcher that
   * hangs shows up as a row with no result rather than as nothing at all (ADR-0047).
   */
  const tools: ToolDispatcher =
    debug === null
      ? worldTools
      : observeToolCalls({
          delegate: worldTools,
          now: () => clock.now(),
          onCall: (call) => {
            trace('tool', `${call.name}(${call.args})`);
            return debug.hub.recordToolCall(call);
          },
          onResult: (seq, result) => {
            debug.hub.recordToolResult(seq, result);
          },
        });

  /**
   * Push-to-talk, both edges — and **this is the wire that was missing**.
   *
   * `beginPlayerTurn` and `endPlayerTurn` existed, `voice/session.ts` implemented the directives
   * behind them, and the voice renderer handled those directives; nothing in between ever called
   * them. The trigger pump dispatched into the interaction machine, the machine drove the chip, and
   * the chip lit up for a turn that never reached a session. It was invisible because every layer
   * was individually tested and the composition root is the only place the gap existed.
   *
   * The machine's *phase* is the source of truth rather than the key events, because the machine is
   * what resolves the gesture: push ends on release and latch ends on the next tap
   * (`endsGesture`), server VAD can end a turn with the key still held (ADR-0017), and a barge-in
   * goes from Speaking straight to Listening with no Armed in between. Reading key events here
   * would be a second copy of all three rules.
   *
   * It is in the shell rather than in `main/session/` because that directory is the pure
   * interaction machine and may not import `@riki/*` at all (eslint.config.js) — it has heard of
   * `turn.responseEnded` and never of a snapshot.
   */
  const capturePhases = new Set(['armed', 'listening']);
  let capturing: TurnId | null = null;
  let lastPhase = runtime.snapshot().phase.kind;

  disposers.push(
    runtime.subscribe((next) => {
      const was = lastPhase;
      const is = next.phase.kind;
      lastPhase = is;
      if (was === is) return;

      // Still capturing. `armed → listening` is the microphone opening, not the gesture ending —
      // conflating the two would cancel every turn a millisecond after it began, which is what the
      // first version of this block did.
      if (capturePhases.has(is)) {
        // Entering the set from outside it is the press. Synchronous all the way down: the
        // overlay's ≤100 ms budget forbids an await between the key press and the window being
        // shown, which is why `beginPlayerTurn` returns an id rather than a promise.
        if (!capturePhases.has(was)) {
          const gesture = next.phase.kind === 'armed' ? next.phase.gesture : 'push';
          capturing = agent.beginPlayerTurn(gesture);
          trace('turn', `push-to-talk ${String(capturing)} (${gesture})`);
        }
        return;
      }

      if (!capturePhases.has(was) || capturing === null) return;
      const turnId = capturing;
      capturing = null;

      // Processing is the release: the gesture ended and there is audio to answer. Leaving a
      // capture phase any other way — Esc, a fault, a device that went away — is a cancellation,
      // and the snapshot is not rendered for one.
      const reason = is === 'processing' ? 'release' : 'cancel';
      trace('turn', `${reason} ${String(turnId)}`);
      void agent.endPlayerTurn(turnId, reason).catch((error: unknown) => {
        // A turn that cannot be handed over is a fault worth reporting and not worth crashing on:
        // the chip is already in Processing, and the session's own fault path takes it from there.
        telemetry.rendererFault(error instanceof Error ? error.message : String(error));
      });
    }),
  );

  // ---------------------------------------------------------------------------------------------
  // The match, which is only the session
  // ---------------------------------------------------------------------------------------------

  let matchId: MatchId | null = null;

  /**
   * The session instructions, assembled once and frozen (ADR-0011), and the session they configure.
   *
   * **The draft comes off the event, not off `state.world`** — `prompt.ts`'s header says why, and it
   * is the one thing here that is easy to get wrong twice: the state subsystem resets the world
   * model before it announces `match_started`, so a listener that reads it on this edge reads
   * nothing and gets no complaint.
   *
   * Failures are swallowed into telemetry deliberately. Every one of them — no API key, a refused
   * mint — leaves a Riki that still observes the game and simply cannot answer, which is a strictly
   * better outcome than a match that does not start.
   *
   * Not awaited by the lifecycle callback: `openMatch` runs on it, and an await there would delay
   * every later observation behind a network round trip.
   */
  async function openSession(id: MatchId, heroes: readonly string[]): Promise<void> {
    try {
      const instructions = buildSessionPrompt(heroes);
      // Still the right match? A quick restart can land here after `closeMatch`, and opening a
      // session for a match that has ended would leave one running with nothing to answer.
      if (matchId !== id) return;
      trace('session', `opening for ${id}, ${String(instructions.length)} chars of instructions`);
      await session.openMatch(instructions);
    } catch (error: unknown) {
      telemetry.sessionOpenFailed(error instanceof Error ? error.message : String(error));
    }
  }

  function closeMatch(): void {
    if (matchId !== null) void session.closeMatch('match ended');
    matchId = null;
  }

  disposers.push(
    state.onLifecycle((event: MatchLifecycleEvent) => {
      if (event.type === 'match_started') {
        // Before the session opens, for the same reason the state subsystem resets the world before
        // it announces: everything the inspector holds is keyed to the match that just ended, and
        // the first turn of the new one must not land in the old one's buffers.
        debug?.hub.resetMatch();
        closeMatch();
        matchId = event.matchId as MatchId;
        void openSession(matchId, event.heroes);
      }
      if (event.type === 'match_ended') closeMatch();
    }),
  );

  // ---------------------------------------------------------------------------------------------
  // What the inspector reads, and what it is told
  // ---------------------------------------------------------------------------------------------

  if (debug !== null) {
    const projectWorldState = projectWorld({ world: state.world, staleness });

    /** `BusStats`' two maps as the frame's arrays, read once so the three reads agree. */
    const busOf = (stats: BusStats): DebugSessionInput['bus'] => ({
      depth: stats.depth,
      dropped: [...stats.dropped].map(([kind, count]) => ({ key: kind, count })),
      gaps: [...stats.gaps].map(([id, count]) => ({ key: id, count })),
    });

    debug.hub.observe({
      session: () => {
        const health = state.health(worldClock.now());
        const chip = runtime.snapshot();
        return {
          matchId: state.matchId,
          // Read separately, because the two disagree exactly when something is wrong: a match id
          // with no session means `match_started` reached the state subsystem and not the shell,
          // which is silent everywhere else.
          matchSession: matchId !== null,
          chipPhase: chip.phase.kind,
          chipVisible: overlay.window.isVisible(),
          muted: chip.muted,
          healthLevel: health.level,
          healthSummary: health.summary,
          sources: health.sources.map((source) => ({
            id: source.id,
            state: source.health.state,
            reason: source.health.reason ?? null,
            lastObservationAt: source.health.lastObservationAt,
            restarts: source.restarts,
          })),
          bus: busOf(state.bus.stats()),
        };
      },

      world: projectWorldState,

      actions: () => debugActions?.list() ?? [],
    });

    // App lifetime, not match lifetime — the same reason the voice bridge is attached here. A
    // transcript can arrive for a turn opened in a match that has since ended, and a subscription
    // rebuilt per match would miss it.
    disposers.push(
      session.onEvent((voice) => {
        if (voice.kind === 'turn' && voice.event === 'responseEnded') {
          debug.hub.recordTurnClosed(String(voice.turnId), 'spoke', clock.now());
          return;
        }
        if (voice.kind !== 'transcript' || !voice.final) return;
        if (voice.role === 'agent') {
          debug.hub.recordAgentTranscript(String(voice.turnId), voice.text);
          return;
        }
        // The player's words are not carried; their length is. `shared/debug.ts`'s header says why.
        debug.hub.recordPlayerTranscript(String(voice.turnId), voice.text.length);
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Health, and the tray's status line
  // ---------------------------------------------------------------------------------------------

  let cancelPoll: (() => void) | null = null;

  function poll(): void {
    const health = state.health(worldClock.now());
    trayController.setStatus(health.summary);
    cancelPoll = timers.after(HEALTH_POLL_MS, poll);
  }

  const quitListeners = new Set<() => void>();
  disposers.push(
    trayController.onAction((action) => {
      if (action === 'quit') for (const listener of [...quitListeners]) listener();
      // The row is only rendered when `debug` exists, so this is unreachable otherwise — but a
      // compromised or stale menu template must not be able to conjure a window either.
      if (action === 'open-debug') void debug?.open();
    }),
    trayController.onToggleMute(() => {
      const muted = !runtime.snapshot().muted;
      runtime.dispatch({ kind: 'mute', muted });
      trayController.setMuted(muted);
    }),
  );

  const shell: RikiShell = {
    state,
    runtime,
    overlay,
    trayController,
    session,
    agent,
    tools,

    get matchId(): MatchId | null {
      return matchId;
    },

    debug,

    async start(): Promise<void> {
      // Warm before binding anything: `showFast()` is a compositor map only if the window already
      // exists and has painted once, and the ≤100 ms budget is spent entirely on a cold start
      // otherwise (§9.1).
      await overlay.window.warm();
      if (!trigger.start()) {
        telemetry.hotkeyUnavailable(config.hotkey.talk, deps.keys.hasKeyUp);
      } else if (!deps.keys.hasKeyUp) {
        // Tap-to-latch works; hold-to-push does not. Saying so is the difference between a known
        // limitation and a product that looks broken (`trigger/index.ts`'s header).
        telemetry.pushToTalkUnavailable();
      }
      await state.start();
      poll();
    },

    async stop(): Promise<void> {
      cancelPoll?.();
      cancelPoll = null;
      closeMatch();
      for (const stop of disposers) stop();
      disposers.length = 0;
      quitListeners.clear();
      trigger.stop();
      runtime.dispose();
      trayController.dispose();
      overlay.dispose();
      debug?.dispose();
      await state.stop();
    },

    onQuitRequested(listener): Unsubscribe {
      quitListeners.add(listener);
      return () => quitListeners.delete(listener);
    },
  };

  return shell;
}

/** Re-exported so `index.ts` and the tests name the same type. */
export type { Millis, UiClock };

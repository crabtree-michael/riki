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
 *   GsiServer ──► ObservationBus ──► WorldModelStore ──onVersion──► EventEngine
 *                                          │                            │ CoachEvent
 *                                          │ WorldModelReader           ▼
 *                                          └──► toContextReader ──► ContextAssembler
 *                                                                       │ snapshot + brief
 *                                                                       ▼
 *                                                              CoachingSessionPort
 *                                                                       │ VoiceEvent
 *                                                                       ▼
 *                                          SessionRuntime ──► OverlayPresenter, Tray
 *                                                 ▲
 *                                          TriggerPump (hotkey)
 * ```
 *
 * ## Two lifetimes, not one
 *
 * The state subsystem, the overlay, the tray and the hotkey live as long as the app. The coaching
 * root does **not**: `ContextAssembler` takes a `MatchId` at construction, the conversation ledger
 * and the coaching memory are per-match by ADR-0012 and ADR-0013, and the Tier 1 preamble is
 * assembled once on `match_started` and frozen (ADR-0011). So a `MatchRuntime` is built on
 * `match_started` and disposed on `match_ended`, and between matches there is no coaching root at
 * all — which is also what gate 1, `not_in_match`, would say anyway.
 *
 * Building it per match rather than resetting one is deliberate. A reset has to remember every
 * piece of state that exists; a fresh object cannot forget one.
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
 * the diagram above and pushes it to a dev-only window. It is composed rather than injected —
 * `TriggerPolicy` and `RikiContext` are decorated on their way into the engine and the agent, and
 * both decorators return their delegate's value unchanged. With the flag off nothing above changes
 * in any way, which is the property the whole component is built around.
 */

import type { CoachModel, CoachTelemetry, LlmCoachConfig } from '@riki/coach';
import { createLlmCoach, withCoachConfig } from '@riki/coach';
import type { MatchId, RikiContext, Timers } from '@riki/context';
import {
  createContextAssembler,
  createPlayerMemoryStore,
  createPreambleAssembler,
} from '@riki/context';
import type { EventTape, TriggerCounters, TriggerPolicy } from '@riki/events';
import {
  DEFAULT_TRIGGER_CONFIG,
  createEventEngine,
  createEventTape,
  createTriggerPolicy,
} from '@riki/events';
import type { MatchLifecycleEvent } from '@riki/gsi';
import type { Clock as WorldClock, MonoMs } from '@riki/world-model';
import { createStalenessPolicy } from '@riki/world-model';

import type { Millis, Unsubscribe } from '../../shared/overlay.js';
import type {
  CoachDriver,
  CoachMode,
  CoachingAgent,
  CoachingSessionPort,
  StaticCoachDriver,
} from '../agent/index.js';
import {
  createCoachingAgent,
  createSnapshotNarrator,
  llmCoachDriver,
  staticCoachDriver,
  toContextReader,
  toEventTapeReader,
} from '../agent/index.js';
import { createVoiceBridge } from '../adapters/voice.js';
import type { DebugSessionInput, DebugSurface, DebugWindowFactory } from '../debug/index.js';
import {
  createDebugComponent,
  createObservingPolicy,
  observeContext,
  projectCounters,
  projectWorld,
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
import { createFileMemoryStore } from './memory-store.js';
import { buildPreambleInput } from './preamble.js';
import { createSilentSession } from './silent-session.js';
import { NULL_REFERENCE_DATA, nullTelemetry, type ShellTelemetry } from './telemetry.js';

export * from './config.js';
export { createFileMemoryStore } from './memory-store.js';
export { buildPreambleInput } from './preamble.js';
export { createSilentSession, NOMINAL_SPEECH_MS } from './silent-session.js';
export type { SilentSession, SilentSessionDeps } from './silent-session.js';
export { nullTelemetry, NULL_REFERENCE_DATA } from './telemetry.js';
export type { ShellTelemetry } from './telemetry.js';

/** How often health is polled and pushed to the tray. §8.1 wants a timer, not a subscription. */
export const HEALTH_POLL_MS = 2_000;

/**
 * How long preamble enrichment may take before the session opens without it.
 *
 * `packages/context` drops enrichment priority-first when this expires, so a slow lookup costs the
 * fifth enemy's matchup note rather than the whole preamble. Generous, because this runs once per
 * match while the draft is still on screen and nothing is waiting on it.
 */
export const PREAMBLE_DEADLINE_MS = 3_000;

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
   * How the LLM coach reaches OpenAI, as a factory rather than a value.
   *
   * A factory because a `CoachModel` owns a pooled transport and is disposed with the coach, so one
   * per match — and because a test substitutes `FakeCoachModel` here without the shell learning what
   * an `Agent` is. `undefined` means the mode cannot be `llm`: `apps/desktop/src/main/index.ts`
   * supplies one only when `config.openai.apiKey` is non-null, which is where the no-key degradation
   * is decided and reported.
   */
  readonly coachModel?: (config: LlmCoachConfig) => CoachModel;
  /**
   * Called when the coach mode actually changed, so the caller can persist it.
   *
   * A callback rather than a write, because this file does no I/O — that is what lets
   * `shell.test.ts` drive the whole composition root with no filesystem. `main/index.ts` wires it to
   * `saveSettings`, and that pairing is the whole of what makes the tray's Coach row survive a
   * restart. Absent means the choice is runtime-only, which is what every test wants.
   */
  readonly onCoachModeChanged?: (mode: CoachMode) => void;
  /**
   * Only consulted when `config.debug.enabled`.
   *
   * Absent in `shell.test.ts` even with the flag on, which is deliberate: everything the inspector
   * *collects* is testable with no window, and the window itself is Tier 5's business.
   */
  readonly debugWindows?: DebugWindowFactory;
}

/**
 * A `CoachingSessionPort` with a match lifetime.
 *
 * The agent's port is deliberately narrower — open a turn, speak, abort, hear the events — and it
 * has no business knowing that a Realtime session exists, let alone when one opens. But *something*
 * has to open one, and the shell is what knows when a match starts: `SessionContext` is frozen at
 * `match_started` (ADR-0011) and the ledger and the coaching memory are per-match (ADR-0012,
 * ADR-0013). So the two extra methods live here rather than in `agent/contracts.ts`.
 */
export interface MatchScopedSession extends CoachingSessionPort {
  /** The preamble, already rendered. Opening is best-effort: a failure is a fault, not a throw. */
  openMatch(preambleText: string): Promise<void>;
  closeMatch(reason: string): Promise<void>;
}

/** The coaching root, which lives for one match. */
export interface MatchRuntime {
  readonly matchId: MatchId;
  readonly context: RikiContext;
  /** Whichever coach is switched on. `driver.mode` says which, and it can change mid-match. */
  readonly driver: CoachDriver;
  readonly agent: CoachingAgent;
  /**
   * Replace the coach in place. Driven by `RikiShell.setCoachMode`, never called directly.
   *
   * On the runtime rather than on the shell because the two objects own different halves of the
   * answer: the shell owns *which mode*, and only a live coaching root can act on it.
   */
  swap(next: CoachMode): void;
  dispose(): void;
}

export interface RikiShell {
  readonly state: StateSubsystemWithExtras;
  readonly runtime: SessionRuntime;
  readonly overlay: OverlaySurface;
  readonly trayController: TrayController;
  readonly session: MatchScopedSession;
  /** Null between matches. See "Two lifetimes" above. */
  readonly match: MatchRuntime | null;
  /** Which coach is running, or would run at the next match. */
  readonly coachMode: CoachMode;
  /**
   * Switch coaches, now.
   *
   * Returns the mode actually in force, which is not always the one asked for: `llm` with no key
   * and no `coachModel` factory degrades to `static` and says so through telemetry. Requirement 1's
   * "runtime-switchable" is this method — see `swapCoach` for what it does and does not preserve.
   */
  setCoachMode(mode: CoachMode): CoachMode;
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
  // the telemetry sink every subsystem is handed, and the trigger policy the per-match engine takes.
  // Everything else it sees, it subscribes to.

  const debug: DebugSurface | null = config.debug.enabled
    ? createDebugComponent({
        ...(deps.debugWindows === undefined ? {} : { windows: deps.debugWindows }),
        timers,
        now: () => clock.now(),
      })
    : null;

  const telemetry: ShellTelemetry =
    debug === null
      ? (deps.telemetry ?? nullTelemetry())
      : withDebugTelemetry({
          hub: debug.hub,
          delegate: deps.telemetry ?? nullTelemetry(),
          now: () => clock.now(),
        });

  // ---------------------------------------------------------------------------------------------
  // Sources and the world model
  // ---------------------------------------------------------------------------------------------

  const registrations: SourceRegistration[] = [deps.sources.gsi(config, worldClock)];

  const logTail = deps.sources.logTail?.(config, worldClock) ?? null;
  if (logTail !== null) registrations.push(logTail);

  const visionSources: string[] = [];
  if (config.vision.enabled && config.vision.binaryPath !== null && deps.processes !== undefined) {
    const sidecar = createSidecarSource({
      processes: deps.processes,
      request: { command: config.vision.binaryPath, args: [] },
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

  const voiceCommands = createVoiceBridge({
    phase: { phase: () => runtime.snapshot().phase.kind },
  });

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

  // App lifetime, not match lifetime. The session outlives any one match and the chip has to react
  // to it in the menu as well as in a game: push-to-talk is not gated on being in a match, only
  // *unprompted* speech is (gate 1, `not_in_match`). Attaching this per match would mean a turn the
  // player asked for produced no chip between games.
  disposers.push(
    voiceCommands.attach(session, (input) => {
      runtime.dispatch(input);
    }),
  );

  // ---------------------------------------------------------------------------------------------
  // The coaching root, per match
  // ---------------------------------------------------------------------------------------------

  const memoryStore = createPlayerMemoryStore({
    store: createFileMemoryStore({ dir: config.dataDir }),
  });

  let match: MatchRuntime | null = null;

  /**
   * The mode in force, which is `config.coach.mode` until somebody moves it.
   *
   * Shell state rather than match state, because it has to survive between games — a player who
   * switches coaches at the end of one match expects the next one to start that way, and the
   * coaching root does not exist in between (ADR-0026).
   */
  let coachMode: CoachMode = config.coach.mode;

  /**
   * Can `llm` actually run?
   *
   * Two things have to be true and neither is a setting: a key resolved from the environment
   * (`@riki/config`), and a factory that knows how to build a model from it. `apps/desktop/src/main/
   * index.ts` supplies the second only when it has the first, so this one check covers both — and it
   * is checked here rather than at the call site so the degradation is reported once, by name,
   * instead of being discovered as a coach that never speaks.
   */
  function llmAvailable(): boolean {
    return config.openai.apiKey !== null && deps.coachModel !== undefined;
  }

  function resolveMode(wanted: CoachMode): CoachMode {
    if (wanted !== 'llm') return wanted;
    if (llmAvailable()) return 'llm';
    telemetry.coachUnavailable('RIKI_OPENAI_API_KEY is not set');
    return 'static';
  }

  /**
   * Build the coach the current mode asks for.
   *
   * Both branches end in a `CoachDriver` and the caller cannot tell them apart, which is the whole
   * point of `agent/driver.ts`. What differs is what each needs to be handed: the deterministic coach
   * wants the shared tape and the novelty gate's memory, and the LLM coach wants a narrator and a
   * model. Neither wants a timer — the LLM coach is push-only.
   */
  function buildDriver(mode: CoachMode, context: RikiContext, tape: EventTape): CoachDriver {
    if (mode === 'llm' && deps.coachModel !== undefined) {
      const coachConfig: LlmCoachConfig = withCoachConfig(
        config.coach.model === null ? {} : { model: config.coach.model },
      );
      return llmCoachDriver(
        createLlmCoach({
          world: state.world,
          // The same renderer the voice model reads, with a wider budget — `narrator.ts` says why
          // that is sound and why it changes none of the conversation window's arithmetic.
          narrator: createSnapshotNarrator({
            world: toContextReader(state.world, { staleness }),
            tape: toEventTapeReader(tape),
          }),
          model: deps.coachModel(coachConfig),
          clock: worldClock,
          config: coachConfig,
          telemetry: telemetry satisfies CoachTelemetry,
        }),
      );
    }

    // `createTriggerPolicy()` is what `createEventEngine` would have built for itself; naming it
    // here is what lets the inspector's observer sit in front of it. The gate ladder is the one
    // thing in the app that is otherwise unreachable — the engine keeps the latch set, the per-kind
    // cooldowns and the intensity score private, and `GateContext` is where they surface.
    //
    // Only the deterministic coach has a ladder to watch: the LLM coach decides inside a model, so
    // under `llm` the Triggers panel is legitimately empty. debug-inspector.md §2.
    const policy: TriggerPolicy = createTriggerPolicy();

    const engine = createEventEngine({
      world: state.world,
      clock: worldClock,
      memory: context.coaching,
      tape,
      policy:
        debug === null
          ? policy
          : createObservingPolicy({
              delegate: policy,
              tapeSalience: DEFAULT_TRIGGER_CONFIG.tapeSalience,
              worldVersion: () => state.world.version,
              report: (tick) => {
                debug.hub.recordTick(tick);
              },
            }),
    });

    return staticCoachDriver(engine);
  }

  /**
   * Switch coaches, now — the implementation behind `RikiShell.setCoachMode` and the tray row.
   *
   * A named function rather than a method body because two callers need it and one of them is
   * registered before the shell object exists.
   */
  function setCoachMode(wanted: CoachMode): CoachMode {
    const before = coachMode;
    coachMode = resolveMode(wanted);
    // Between matches there is no coaching root to swap, and that is not a failure: the mode is
    // shell state and `openMatch` reads it. The tray reflects the answer either way.
    match?.swap(coachMode);
    // Only on a real change, and only the *resolved* mode — asking for `llm` with no key behind it
    // persists `static`, because that is what the player will actually get next launch and a
    // settings file that disagrees with the tray is worse than one that is merely conservative.
    if (coachMode !== before) deps.onCoachModeChanged?.(coachMode);
    return coachMode;
  }

  function openMatch(matchId: string): void {
    closeMatch();

    // The tape is built first and shared, because the two consumers depend on each other in a
    // circle otherwise: `ContextAssembler` wants an `EventTapeReader`, and `EventEngine` wants the
    // assembler's `CoachingMemoryReader`. Hoisting the one thing they both need breaks it.
    //
    // Under the LLM coach nothing fills it — the tape is `packages/events`' record of its own
    // detections — so `recent:` renders empty and the narrator says nothing about what has been
    // happening. That is a real gap in `llm` mode rather than a shrug, and it is
    // llm-coach-architecture.md §14 row 3.
    const tape = createEventTape();

    const assembled = createContextAssembler({
      matchId: matchId as MatchId,
      world: toContextReader(state.world, { staleness }),
      preamble: createPreambleAssembler({ reference: NULL_REFERENCE_DATA }),
      tape: toEventTapeReader(tape),
      durable: memoryStore,
    });

    // Decoration, not instrumentation: `observeContext` returns the assembler's own answers and the
    // agent cannot tell the difference. Everything downstream is handed this one either way, so the
    // player-turn path is covered as well as the coaching one — and so is whichever coach is
    // running, since both are built from this `context`.
    const context: RikiContext =
      debug === null
        ? assembled
        : observeContext({
            delegate: assembled,
            clock: () => state.world.snapshot(worldClock.now()).clock,
            onOpened: (turn) => {
              debug.hub.recordTurnOpened(turn);
            },
            onClosed: (turnId, outcome) => {
              debug.hub.recordTurnClosed(turnId, outcome);
            },
          });

    coachMode = resolveMode(coachMode);
    let driver = buildDriver(coachMode, context, tape);
    let agent = createCoachingAgent({
      world: state.world,
      context,
      driver,
      session,
      clock: worldClock,
      telemetry,
    });

    // dota2 §6.4's off switch, from settings. Applied before `start()` so a player who turned
    // unprompted speech off never hears a first trigger slip through on launch. It is one of the
    // two controls both coaches honour identically (`llm-coach-architecture.md` §4.3).
    driver.setQuietMode(!config.privacy.unprompted);
    let stopAgent = agent.start();
    telemetry.coachMode(driver.mode);

    /**
     * Swap the coach without ending the match.
     *
     * **What survives:** the conversation ledger, the coaching memory, the preamble, the durable
     * player memory and the session. All of them belong to the match rather than to the coach, and
     * a mode change is not a new game.
     *
     * **What does not:** the deterministic coach's latches and cooldowns, and the LLM coach's record
     * of what it said. Both are the *coach's* memory of its own behaviour, and neither translates —
     * a latch on `enemy_missing:sf` means nothing to a model, and "I said this forty seconds ago"
     * means nothing to a gate ladder. So the new coach starts fresh, which in practice means the
     * first moments after a switch may repeat something the previous coach covered. That is the
     * honest cost of switching mid-match and it is why the tray row exists for tuning rather than
     * as a thing to flip during a fight.
     */
    function swap(next: CoachMode): void {
      if (next === driver.mode) return;
      stopAgent();
      agent.dispose();

      driver = buildDriver(next, context, tape);
      agent = createCoachingAgent({
        world: state.world,
        context,
        driver,
        session,
        clock: worldClock,
        telemetry,
      });
      driver.setQuietMode(!config.privacy.unprompted);
      stopAgent = agent.start();
      telemetry.coachMode(driver.mode);
    }

    match = {
      matchId: matchId as MatchId,
      context,
      get driver(): CoachDriver {
        return driver;
      },
      get agent(): CoachingAgent {
        return agent;
      },
      swap,
      dispose(): void {
        stopAgent();
        agent.dispose();
      },
    };

    // The Tier 1 preamble, then the session. Both are async and neither may block this function:
    // `openMatch` runs on the lifecycle callback, and an await here would delay every later
    // observation behind a network round trip.
    //
    // Not awaited also means the first coaching turn can be handed over before the session is
    // open. That is the reason `main/voice/session.ts` queues directives until `voice.ready` —
    // without it the first advice of a match would be the one that reliably disappeared.
    void openSession(matchId as MatchId, context);
  }

  /**
   * The preamble, assembled once and frozen (ADR-0011), and the Realtime session it configures.
   *
   * Failures are swallowed into telemetry deliberately. Every one of them — no API key, a refused
   * mint, an empty draft — leaves a Riki that still detects, still gates, still assembles briefs
   * and simply does not speak, which is a strictly better outcome than a match that does not start.
   */
  async function openSession(matchId: MatchId, context: RikiContext): Promise<void> {
    try {
      const memory = await memoryStore.load();
      const now = worldClock.now();
      const assembled = await context.openSession(
        buildPreambleInput(matchId, state.world, memory, now),
        (now + PREAMBLE_DEADLINE_MS) as MonoMs,
      );
      // Still the right match? A quick restart can land here after `closeMatch`, and opening a
      // session for a match that has ended would leave one running with nothing to say.
      if (match?.matchId !== matchId) return;
      await session.openMatch(assembled.preamble.text);
    } catch (error: unknown) {
      telemetry.sessionOpenFailed(error instanceof Error ? error.message : String(error));
    }
  }

  function closeMatch(): void {
    if (match !== null) void session.closeMatch('match ended');
    match?.dispose();
    match = null;
  }

  disposers.push(
    state.onLifecycle((event: MatchLifecycleEvent) => {
      if (event.type === 'match_started') {
        // Before `openMatch`, for the same reason the state subsystem resets the world before it
        // announces: everything the inspector holds is keyed to the match that just ended, and the
        // first tick of the new one must not land in the old one's buffers.
        debug?.hub.resetMatch();
        openMatch(event.matchId);
      }
      if (event.type === 'match_ended') {
        closeMatch();
        // Durable memory is batched — at match end and on a slow timer, never per observation
        // (context-and-memory §6.4).
        void memoryStore.flush();
      }
    }),
  );

  // ---------------------------------------------------------------------------------------------
  // What the inspector reads, and what it is told
  // ---------------------------------------------------------------------------------------------

  if (debug !== null) {
    const projectWorldState = projectWorld({ world: state.world, staleness });

    /**
     * The engine's counters, or null when there is no engine to ask.
     *
     * A hand-written guard because `CoachDriver` is an interface with a `mode` field rather than a
     * discriminated union, so `mode === 'static'` narrows nothing on its own. Widening the port to
     * a union to please this one call site would put `engine` back on the interface that
     * `agent/driver.ts` deliberately keeps it off.
     */
    const staticCountersOf = (driver: CoachDriver | undefined): TriggerCounters | null =>
      driver?.mode === 'static' ? (driver as StaticCoachDriver).engine.counters() : null;

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
          // with no coaching root means `match_started` reached the state subsystem and not the
          // shell, which is silent everywhere else.
          coachingRoot: match !== null,
          chipPhase: chip.phase.kind,
          chipVisible: overlay.window.isVisible(),
          muted: chip.muted,
          // The driver's mode rather than the shell's `coachMode`: between matches there is no
          // driver, and "which coach *would* run" is a different claim from "which one is running".
          coachMode: match?.driver.mode ?? 'none',
          unprompted: config.privacy.unprompted,
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

      /**
       * Empty between matches *and* under the LLM coach, for two different right reasons.
       *
       * Between matches: the counters live on the engine and the engine lives for one match
       * (ADR-0026). Under `llm`: `packages/events` is not running at all, so there is nothing to
       * count — the two coaches' counter shapes share no fields, which is exactly why
       * `agent/driver.ts` keeps `engine` off the port and puts it on `StaticCoachDriver`.
       * `session.coachMode` in the same frame is what tells the two cases apart.
       */
      counters: () => {
        const counters = staticCountersOf(match?.driver);
        return counters === null
          ? { detected: [], suppressed: [], spoken: 0 }
          : projectCounters(counters);
      },
    });

    // App lifetime, not match lifetime — the same reason the voice bridge is attached here. A
    // transcript can arrive for a turn opened in a match that has since ended, and a subscription
    // rebuilt per match would miss it.
    disposers.push(
      session.onEvent((voice) => {
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
    trayController.onAction((action) => {
      if (action !== 'toggle-coach') return;
      // The tray reflects what actually happened, not what was asked for: `setCoachMode` returns
      // `static` when `llm` has no key behind it, and a checkbox that ticked anyway would be the
      // product lying about its own state.
      const next = setCoachMode(coachMode === 'llm' ? 'static' : 'llm');
      trayController.setCoach(next, llmAvailable());
    }),
  );

  trayController.setCoach(coachMode, llmAvailable());

  const shell: RikiShell = {
    state,
    runtime,
    overlay,
    trayController,
    session,

    get match(): MatchRuntime | null {
      return match;
    },

    get coachMode(): CoachMode {
      return coachMode;
    },

    setCoachMode(wanted: CoachMode): CoachMode {
      const next = setCoachMode(wanted);
      trayController.setCoach(next, llmAvailable());
      return next;
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
      await memoryStore.flush();
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

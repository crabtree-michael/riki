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
 * ## What is not wired, and why
 *
 * **Speech.** See `silent-session.ts`: the Realtime session runs in a renderer that does not exist
 * yet, and there is no permitted way to reach the API key until `packages/config` lands. Every
 * stage up to the point of speaking is real and running.
 */

import type { CoachModel, CoachTelemetry, LlmCoachConfig } from '@riki/coach';
import { createLlmCoach, withCoachConfig } from '@riki/coach';
import type { MatchId, RikiContext, Timers } from '@riki/context';
import {
  createContextAssembler,
  createPlayerMemoryStore,
  createPreambleAssembler,
} from '@riki/context';
import type { EventTape } from '@riki/events';
import { createEventEngine, createEventTape } from '@riki/events';
import type { MatchLifecycleEvent } from '@riki/gsi';
import type { Clock as WorldClock, MonoMs } from '@riki/world-model';
import { createStalenessPolicy } from '@riki/world-model';

import type { Millis, Unsubscribe } from '../../shared/overlay.js';
import type { CoachDriver, CoachMode, CoachingAgent, CoachingSessionPort } from '../agent/index.js';
import {
  createCoachingAgent,
  createSnapshotNarrator,
  llmCoachDriver,
  staticCoachDriver,
  toContextReader,
  toEventTapeReader,
} from '../agent/index.js';
import { createVoiceBridge } from '../adapters/voice.js';
import type { OverlaySurface } from '../overlay/index.js';
import { createOverlaySurface } from '../overlay/index.js';
import type { OverlayWindowFactory } from '../overlay/window-port.js';
import type { Clock as UiClock, SessionRuntime } from '../session/index.js';
import { DEFAULT_ENVIRONMENT, createSessionRuntime, machine } from '../session/index.js';
import type { MachineEnvironment } from '../session/types.js';
import type { SourceRegistration, StateSubsystemWithExtras } from '../state/index.js';
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
import { createSilentSession } from './silent-session.js';
import { NULL_REFERENCE_DATA, nullTelemetry, type ShellTelemetry } from './telemetry.js';

export * from './config.js';
export { createFileMemoryStore } from './memory-store.js';
export { createSilentSession, NOMINAL_SPEECH_MS } from './silent-session.js';
export type { SilentSession, SilentSessionDeps } from './silent-session.js';
export { nullTelemetry, NULL_REFERENCE_DATA } from './telemetry.js';
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
  /** Defaults to `createSilentSession`. The voice window replaces this and nothing else. */
  readonly session?: CoachingSessionPort;
  readonly environment?: MachineEnvironment;
  /**
   * How the LLM coach reaches OpenAI, as a factory rather than a value.
   *
   * A factory because a `CoachModel` owns a pooled transport and is disposed with the coach, so one
   * per match — and because a test substitutes `FakeCoachModel` here without the shell learning what
   * an `Agent` is. `undefined` means the mode cannot be `llm`: `apps/desktop/src/main/index.ts`
   * supplies one only when `config.coach.apiKey` is non-null, which is where the no-key degradation
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
  readonly session: CoachingSessionPort;
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
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The tray's Quit row and the app's own quit path both land here. */
  onQuitRequested(listener: () => void): Unsubscribe;
}

export function createRikiShell(deps: ShellDeps): RikiShell {
  const { config, clock, timers } = deps;
  const telemetry: ShellTelemetry = deps.telemetry ?? nullTelemetry();

  // One clock, two vocabularies. `Millis` and `MonoMs` are the same monotonic number; the brand is
  // what stops a wall-clock date being passed where an uptime is expected.
  const worldClock: WorldClock = { now: (): MonoMs => clock.now() as MonoMs };
  const staleness = createStalenessPolicy();

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

  const trayController = createTrayController(deps.tray);
  const session: CoachingSessionPort =
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
    return config.coach.apiKey !== null && deps.coachModel !== undefined;
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

    return staticCoachDriver(
      createEventEngine({
        world: state.world,
        clock: worldClock,
        memory: context.coaching,
        tape,
      }),
    );
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

    const context = createContextAssembler({
      matchId: matchId as MatchId,
      world: toContextReader(state.world, { staleness }),
      preamble: createPreambleAssembler({ reference: NULL_REFERENCE_DATA }),
      tape: toEventTapeReader(tape),
      durable: memoryStore,
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
    driver.setQuietMode(!config.unprompted);
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
      driver.setQuietMode(!config.unprompted);
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
  }

  function closeMatch(): void {
    match?.dispose();
    match = null;
  }

  disposers.push(
    state.onLifecycle((event: MatchLifecycleEvent) => {
      if (event.type === 'match_started') openMatch(event.matchId);
      if (event.type === 'match_ended') {
        closeMatch();
        // Durable memory is batched — at match end and on a slow timer, never per observation
        // (context-and-memory §6.4).
        void memoryStore.flush();
      }
    }),
  );

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

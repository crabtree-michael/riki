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

import type { MatchId, RikiContext, Timers } from '@riki/context';
import {
  createContextAssembler,
  createPlayerMemoryStore,
  createPreambleAssembler,
} from '@riki/context';
import type { EventEngine } from '@riki/events';
import { createEventEngine, createEventTape } from '@riki/events';
import type { MatchLifecycleEvent } from '@riki/gsi';
import type { Clock as WorldClock, MonoMs } from '@riki/world-model';
import { createStalenessPolicy } from '@riki/world-model';

import type { Millis, Unsubscribe } from '../../shared/overlay.js';
import type { CoachingAgent, CoachingSessionPort } from '../agent/index.js';
import { createCoachingAgent, toContextReader, toEventTapeReader } from '../agent/index.js';
import { createVoiceBridge } from '../adapters/voice.js';
import type { OverlaySurface } from '../overlay/index.js';
import { createOverlaySurface } from '../overlay/index.js';
import type { OverlayWindowFactory } from '../overlay/window-port.js';
import type { Clock as UiClock, SessionRuntime } from '../session/index.js';
import { DEFAULT_ENVIRONMENT, createSessionRuntime, machine } from '../session/index.js';
import type { MachineEnvironment } from '../session/types.js';
import type { SourceRegistration, StateSubsystemWithExtras } from '../state/index.js';
import { SIDECAR_RESTART, buildStateSubsystem } from '../state/index.js';
import { createSidecarSource } from '../sidecar/index.js';
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
}

/** The coaching root, which lives for one match. */
export interface MatchRuntime {
  readonly matchId: MatchId;
  readonly context: RikiContext;
  readonly engine: EventEngine;
  readonly agent: CoachingAgent;
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

  function openMatch(matchId: string): void {
    closeMatch();

    // The tape is built first and shared, because the two consumers depend on each other in a
    // circle otherwise: `ContextAssembler` wants an `EventTapeReader`, and `EventEngine` wants the
    // assembler's `CoachingMemoryReader`. Hoisting the one thing they both need breaks it.
    const tape = createEventTape();

    const context = createContextAssembler({
      matchId: matchId as MatchId,
      world: toContextReader(state.world, { staleness }),
      preamble: createPreambleAssembler({ reference: NULL_REFERENCE_DATA }),
      tape: toEventTapeReader(tape),
      durable: memoryStore,
    });

    const engine = createEventEngine({
      world: state.world,
      clock: worldClock,
      memory: context.coaching,
      tape,
    });

    // dota2 §6.4's off switch, from settings. Applied before `start()` so a player who turned
    // unprompted speech off never hears a first trigger slip through on launch.
    engine.setQuietMode(!config.unprompted);

    const agent = createCoachingAgent({
      world: state.world,
      context,
      engine,
      session,
      clock: worldClock,
      telemetry,
    });

    const stopAgent = agent.start();

    match = {
      matchId: matchId as MatchId,
      context,
      engine,
      agent,
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
  );

  return {
    state,
    runtime,
    overlay,
    trayController,
    session,

    get match(): MatchRuntime | null {
      return match;
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
}

/** Re-exported so `index.ts` and the tests name the same type. */
export type { Millis, UiClock };

/**
 * What the inspector needs from the rest of main, as ports.
 *
 * The whole component is built around one rule: **nothing here may change what the app does unless
 * somebody asks it to.** An inspector that perturbs the thing it inspects produces readings nobody
 * can act on, and this is a proactive-speech product where the failure mode of a perturbation is
 * Riki talking when it should not. So every seam below is either a pure observer of a value that was
 * going to be produced anyway, or a decorator that returns its delegate's answer unchanged.
 *
 * The one seam that is neither is `DebugActionPort` (ADR-0039), and it is the exception that keeps
 * the rule readable: it is the *only* thing in this component that can change behaviour, it does
 * nothing at all until an `action` intent arrives, and what it can reach is a registry rather than a
 * surface. `actions.ts` is where that boundary is drawn and argued.
 *
 * One decorator survives ADR-0042, and the composition root installs it because it is a thing the
 * root already injects:
 *
 * | Seam | What it sees | Why a decorator and not a new event |
 * |---|---|---|
 * | `SnapshotSource` | the rendered snapshot | it is returned to the agent, composed into one system message, and forgotten — nothing keeps the live text |
 *
 * The other one observed `TriggerPolicy`, and it went with the policy. `packages/context` is
 * unchanged by this component, which is the point: the shell already takes the snapshot source by
 * injection, so the inspector is composition rather than instrumentation.
 *
 * See docs/design/debug-inspector.md §3.
 */

import type { DebugAction, DebugCommand, DebugFrame, DebugIntent } from '../../shared/debug.js';
import type { Unsubscribe } from '../../shared/overlay.js';
import type { DebugActionPort } from './actions.js';

/**
 * Where every observation lands, and the only thing that holds inspector state.
 *
 * Every `record*` method is total and cheap: they are called from the turn path, which has a
 * latency budget this component does not get to spend.
 * Nothing here allocates unboundedly — the ring buffers are capped by `DEBUG_LIMITS`.
 */
export interface DebugHub {
  /** A full frame, as of `now`. Built on demand; nothing is retained between calls. */
  frame(now: number): DebugFrame;

  recordTurnOpened(turn: DebugTurnOpenedInput): void;
  recordTurnClosed(turnId: string, outcome: string): void;
  /** Riki's own final transcript, joined to its turn. */
  recordAgentTranscript(turnId: string, text: string): void;
  /** The player's, as a length only. See `shared/debug.ts`'s header. */
  recordPlayerTranscript(turnId: string, chars: number): void;
  recordProblem(origin: string, message: string, at: number): void;

  /**
   * One step of the turn chain, in order (ADR-0039).
   *
   * Separate from `recordProblem` because a trace step is usually not a fault — it is the ordinary
   * progress of a chain, and the reason the panel exists is that a chain which stops halfway
   * produces *no* fault anywhere. The absence of the next step is the finding.
   */
  recordTrace(stage: string, message: string, at: number): void;
  /** Mark the start of a run, so subsequent steps carry `sinceRunMs`. Null ends the run. */
  markTraceRun(startedAt: number | null): void;
  clearTrace(): void;

  /** Everything that is read rather than pushed arrives through these, set by the shell. */
  observe(sources: DebugSources): void;

  /** Everything keyed to the match that just ended. */
  resetMatch(): void;
  dispose(): void;
}

/**
 * The pull half: values the hub reads when it builds a frame, rather than being told about.
 *
 * Pull and not push for the things that change on every world-model version bump. At 2–8 Hz,
 * pushing the world into the hub would mean building a projection several times a second that
 * nobody is looking at; reading it at frame time means the cost is paid only while the window is
 * actually open.
 *
 * Every member is optional and every one is total — the shell wires what exists, and between
 * matches most of this is genuinely absent.
 */
export interface DebugSources {
  readonly session?: () => DebugSessionInput;
  readonly world?: (now: number) => DebugWorldInput;
  /** The Actions panel, pulled like everything else current-valued: `running` changes under it. */
  readonly actions?: () => readonly DebugAction[];
}

export interface DebugSessionInput {
  readonly matchId: string | null;
  readonly matchSession: boolean;
  readonly chipPhase: string;
  readonly chipVisible: boolean;
  readonly muted: boolean;
  readonly healthLevel: string;
  readonly healthSummary: string;
  readonly sources: readonly {
    readonly id: string;
    readonly state: string;
    readonly reason: string | null;
    readonly lastObservationAt: number | null;
    readonly restarts: number;
  }[];
  readonly bus: {
    readonly depth: number;
    readonly dropped: readonly { readonly key: string; readonly count: number }[];
    readonly gaps: readonly { readonly key: string; readonly count: number }[];
  };
}

export interface DebugWorldInput {
  readonly version: number;
  readonly clock: number | null;
  readonly paused: boolean;
  readonly facts: readonly {
    readonly path: string;
    readonly value: string;
    readonly source: string;
    readonly confidence: number;
    readonly staleness: string;
    readonly ageMs: number;
    readonly ageBasis: string;
  }[];
  readonly enemies: readonly {
    readonly hero: string;
    readonly staleness: string;
    readonly alive: boolean | null;
    readonly level: number | null;
    readonly position: string | null;
    readonly lastSeenAt: string | null;
    readonly itemsSeen: readonly string[];
  }[];
  readonly derived: readonly {
    readonly id: string;
    readonly value: string | null;
    readonly confidence: number | null;
  }[];
}

// -----------------------------------------------------------------------------------------------
// What the decorator reports
// -----------------------------------------------------------------------------------------------

export interface DebugTurnOpenedInput {
  readonly turnId: string;
  readonly at: number;
  readonly clock: number | null;
  readonly cause: string;
  readonly snapshotText: string;
  readonly snapshotTokens: number;
  readonly snapshotOmitted: readonly string[];
}

// -----------------------------------------------------------------------------------------------
// The window
// -----------------------------------------------------------------------------------------------

/**
 * The seam between the inspector and Electron, narrow for the same reason `OverlayWindow` is: a
 * controller that can construct a `BrowserWindow` is a controller that cannot be tested without a
 * display.
 */
export interface DebugWindow {
  /** Loads the renderer and shows it. Unlike the overlay, this window is meant to take focus. */
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  send(command: DebugCommand): void;
  onIntent(fn: (intent: DebugIntent) => void): Unsubscribe;
  /** Fires when the user closes the window with the OS control rather than through the tray. */
  onClosed(fn: () => void): Unsubscribe;
  destroy(): void;
}

export interface DebugWindowFactory {
  create(): DebugWindow;
}

/** What the shell exposes. Null when `config.debug.enabled` is false, which is the default. */
export interface DebugSurface {
  readonly hub: DebugHub;
  /**
   * The scenarios this inspector may run (ADR-0039), or null when it may display them and not run
   * them.
   *
   * Exposed for the same reason `hub` is: everything this component does has to be drivable without
   * a window, and it is what `shell.test.ts` uses to assert that a scenario reaches the session.
   */
  readonly actions: DebugActionPort | null;
  /** Idempotent: opening an already-open inspector focuses it rather than making a second one. */
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

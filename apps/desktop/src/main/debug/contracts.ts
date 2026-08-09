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
 * Two decorators, and the composition root installs both because both are things the root already
 * injects:
 *
 * | Seam | What it sees | Why a decorator and not a new event |
 * |---|---|---|
 * | `SnapshotSource` | the rendered snapshot | it is returned to the agent, composed into one system message, and forgotten — nothing keeps the live text |
 * | `ToolDispatcher` | every tool call and its answer | the same: a `function_call_output` is composed, sent to the session and dropped, and the call is the half of a turn nothing else records (ADR-0047) |
 *
 * A third observed `TriggerPolicy`, and it went with the policy. Neither `packages/context` nor
 * `packages/realtime` is changed by this component, which is the point: the shell already takes
 * both of these by injection, so the inspector is composition rather than instrumentation.
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
  /** `at` is what times the question-to-answer leg; the hub has no clock of its own. */
  recordTurnClosed(turnId: string, outcome: string, at: number): void;
  /** Riki's own final transcript, joined to its turn. */
  recordAgentTranscript(turnId: string, text: string): void;
  /** The player's, as a length only. See `shared/debug.ts`'s header. */
  recordPlayerTranscript(turnId: string, chars: number): void;
  recordProblem(origin: string, message: string, at: number): void;

  /**
   * A tool call, attributed to the turn that was open when it was made.
   *
   * **The hub decides which turn, and no caller passes an id.** `ToolDispatcher.call` is
   * `(name, args)` and carries no turn — widening it so the inspector could read one would make
   * `packages/realtime` aware of a debug window, which is exactly the instrumentation ADR-0032
   * exists to avoid. The Realtime session answers one response at a time, so "the newest turn" is
   * unambiguous; ADR-0047 argues the case and names what it gets wrong.
   *
   * Returns the call's `seq`, which is the only handle `recordToolResult` accepts.
   */
  recordToolCall(call: DebugToolCallInput): number;
  /** Joined by `seq`. A result for a call whose turn has already fallen out of the buffer is dropped. */
  recordToolResult(seq: number, result: DebugToolResultInput): void;

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

export interface DebugToolCallInput {
  /** Whatever the model asked for. Not `ToolName`: a call for a tool that does not exist is a call. */
  readonly name: string;
  /** Already JSON, already clipped by the caller's own bound if it has one. See `renderValue`. */
  readonly args: string;
  readonly at: number;
}

/**
 * How a call ended.
 *
 * A real union here and a plain `string` in `shared/debug.ts`, which is the same split every other
 * status in this component uses: main switches on it, the renderer only ever prints it, and a copy
 * of the union on the far side of the IPC boundary would be a second declaration to keep in step.
 */
export interface DebugToolResultInput {
  /**
   * `ok` — a tool answered.
   * `unknown` — a tool answered that nothing was observed, which is an answer and not a fault
   * (ADR-0043).
   * `refused` — no tool ran: the name was not one of the five, or the arguments failed the schema.
   * `failed` — a tool threw.
   */
  readonly status: 'ok' | 'unknown' | 'refused' | 'failed';
  /** The result as JSON, or the reason there is not one. */
  readonly result: string;
  readonly at: number;
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

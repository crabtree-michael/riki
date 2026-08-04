/**
 * What the inspector needs from the rest of main, as ports.
 *
 * The whole component is built around one rule: **nothing here may change what the app does unless
 * somebody asks it to.** An inspector that perturbs the thing it inspects produces readings nobody
 * can act on, and this is a proactive-speech product where the failure mode of a perturbation is
 * Riki talking when it should not. So every seam below is either a pure observer of a value that was
 * going to be produced anyway, or a decorator that returns its delegate's answer unchanged.
 *
 * The one seam that is neither is `DebugControlPort` (ADR-0037), and it is the exception that keeps
 * the rule readable: it is the *only* thing in this component that can change behaviour, it does
 * nothing at all until a `control` intent arrives, and what it can reach is a registry rather than a
 * surface. `controls.ts` is where that boundary is drawn and argued.
 *
 * The two decorators are the interesting ones, and both are installed by the composition root
 * because both are things it already injects:
 *
 * | Seam | What it sees | Why a decorator and not a new event |
 * |---|---|---|
 * | `TriggerPolicy` | every candidate, every gate | `TriggerDecision` carries the winner and one reason; the other twelve verdicts exist only inside `policy.decide` |
 * | `RikiContext` | the rendered snapshot and brief | `TurnContext` is returned to the agent and never stored; the ledger keeps the text but is not projected anywhere a person can read |
 *
 * `packages/events` and `packages/context` are unchanged by this component, and that is the point:
 * both already take these collaborators by injection, so the inspector is composition rather than
 * instrumentation.
 *
 * See docs/design/debug-inspector.md §3.
 */

import type {
  DebugAction,
  DebugCommand,
  DebugControl,
  DebugFrame,
  DebugIntent,
  DebugMockState,
} from '../../shared/debug.js';
import type { Unsubscribe } from '../../shared/overlay.js';
import type { DebugActionPort } from './actions.js';
import type { DebugControlPort } from './controls.js';
import type { DebugRehearsalPort } from './rehearsal.js';

/**
 * Where every observation lands, and the only thing that holds inspector state.
 *
 * Every `record*` method is total and cheap: they are called from the trigger path and from the
 * turn path, both of which have latency budgets that this component does not get to spend.
 * Nothing here allocates unboundedly — the ring buffers are capped by `DEBUG_LIMITS`.
 */
export interface DebugHub {
  /** A full frame, as of `now`. Built on demand; nothing is retained between calls. */
  frame(now: number): DebugFrame;

  recordTick(tick: DebugTickInput): void;
  /**
   * The LLM coach passed on a moment, and said why in a sentence.
   *
   * Separate from `recordTick` because the two coaches produce genuinely different shapes:
   * `packages/events` evaluates a ladder and this is the whole of what `packages/coach` has to
   * report. It lands in the same buffer so the Triggers panel is one list either way — a mode
   * switch mid-match should read as a change of detail, not as the panel going blank.
   */
  recordDecline(reason: string, at: number, clock: number | null): void;
  recordTurnOpened(turn: DebugTurnOpenedInput): void;
  recordTurnClosed(turnId: string, outcome: string): void;
  /** The coach's own final transcript, joined to its turn. */
  recordAgentTranscript(turnId: string, text: string): void;
  /** The player's, as a length only. See `shared/debug.ts`'s header. */
  recordPlayerTranscript(turnId: string, chars: number): void;
  recordProblem(origin: string, message: string, at: number): void;
  recordEmptyBrief(): void;

  /**
   * One step of the coaching chain, in order (ADR-0039).
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

  /** Between matches there is no coaching root, and the per-match counters go with it. */
  resetMatch(): void;
  dispose(): void;
}

/**
 * The pull half: values the hub reads when it builds a frame, rather than being told about.
 *
 * Pull and not push for the things that change on every world-model version bump. At 2–8 Hz with
 * eight detectors, pushing the world into the hub would mean building a projection thirty times a
 * second that nobody is looking at; reading it at frame time means the cost is paid only while the
 * window is actually open.
 *
 * Every member is optional and every one is total — the shell wires what exists, and between
 * matches most of this is genuinely absent.
 */
export interface DebugSources {
  readonly session?: () => DebugSessionInput;
  readonly world?: (now: number) => DebugWorldInput;
  readonly counters?: () => DebugCountersInput;
  /**
   * The Controls panel, pulled like everything else current-valued.
   *
   * Pulled rather than pushed even though the window is the usual thing that changes it, because it
   * is not the only one: the tray's Coach row moves `coach.mode`, and `setCoachMode` can answer with
   * a mode nobody asked for. A panel drawn from what the renderer last sent would be wrong in
   * exactly those cases, which are the ones worth seeing.
   */
  readonly controls?: () => readonly DebugControl[];
  /**
   * The mock game states a rehearsal may name (ADR-0038), pulled for the same reason `controls` is.
   *
   * The library is a directory listing, so a fixture added while the window is open should appear
   * in the dropdown without a restart — which a value captured at wiring time could not do.
   */
  readonly mocks?: () => readonly DebugMockState[];
  /** The Actions panel. Pulled like the controls, and for the same reason: `running` changes. */
  readonly actions?: () => readonly DebugAction[];
}

export interface DebugSessionInput {
  readonly matchId: string | null;
  readonly coachingRoot: boolean;
  readonly chipPhase: string;
  readonly chipVisible: boolean;
  readonly muted: boolean;
  /** `static` | `llm`, from `CoachDriver.mode`. Changes what the rest of a frame can contain. */
  readonly coachMode: string;
  /** `config.unprompted` — the setting `driver.setQuietMode(!unprompted)` is applied from. */
  readonly unprompted: boolean;
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

/**
 * The engine's mutable state, as of the last tick.
 *
 * **It arrives with a tick rather than being read.** `EventEngine` exposes `counters()` and the four
 * setters and nothing else — the latch set, the cooldown clocks and the intensity score are private
 * to it, which is right: they are the engine's invariants and an accessor would be an invitation to
 * write to them. But `GateContext` is assembled from all of them once per tick and handed to the
 * policy, so the policy decorator sees the lot without `packages/events` changing at all.
 *
 * The cost of that route is stated where it shows: these values are current as of the last world
 * model version bump, not as of the frame. Between bumps a cooldown's `remainingMs` is a snapshot
 * that has stopped counting down, which is why the inspector labels the panel with the tick it came
 * from rather than presenting it as live.
 */
export interface DebugGateInput {
  readonly quietMode: boolean;
  readonly agentSpeaking: boolean;
  readonly playerSpeaking: boolean;
  readonly mutedUntilMs: number | null;
  readonly intensity: number;
  readonly intensityThreshold: number;
  readonly speakThreshold: number;
  readonly lastSpokeAtMs: number | null;
  readonly globalCooldownMs: number;
  readonly latched: readonly string[];
  readonly kindCooldowns: readonly { readonly kind: string; readonly remainingMs: number }[];
}

export interface DebugCountersInput {
  readonly detected: readonly { readonly key: string; readonly count: number }[];
  readonly suppressed: readonly { readonly key: string; readonly count: number }[];
  readonly spoken: number;
}

// -----------------------------------------------------------------------------------------------
// What the two decorators report
// -----------------------------------------------------------------------------------------------

export interface DebugTickInput {
  readonly at: number;
  readonly clock: number | null;
  readonly worldVersion: number;
  /** The whole of the engine's mutable state, from the `GateContext` this tick was decided against. */
  readonly gates: DebugGateInput;
  readonly candidates: readonly {
    readonly kind: string;
    readonly key: string;
    readonly salience: number;
    readonly magnitude: number;
    readonly confidence: number;
    readonly actWithinSeconds: number | null;
    readonly text: string;
    readonly taped: boolean;
    readonly ladder: readonly { readonly reason: string; readonly refuses: boolean }[];
    readonly rank: 'winner' | 'ranked-below';
  }[];
  readonly decision:
    | { readonly speak: true; readonly key: string }
    | { readonly speak: false; readonly reason: string; readonly key: string | null };
}

export interface DebugTurnOpenedInput {
  readonly turnId: string;
  readonly at: number;
  readonly clock: number | null;
  readonly cause: string;
  readonly eventId: string | null;
  readonly salience: number | null;
  readonly snapshotText: string;
  readonly snapshotTokens: number;
  readonly briefText: string;
  readonly briefTokens: number;
  readonly briefSections: readonly string[];
  readonly briefOmitted: readonly string[];
  readonly briefEmpty: boolean;
  /**
   * The line the LLM coach drafted for this turn, or null.
   *
   * Present and nullable rather than optional, for the reason `DebugControl`'s fields are: `null`
   * from the live path is a *claim* — the static coach drafts nothing, and the decorator that
   * observes `openTurn` cannot see a proposal at all — and a field that were merely absent would
   * make "no drafted line" and "this projection forgot" look the same.
   */
  readonly guidance: string | null;
  /** The mock state a rehearsal ran against (ADR-0038); null for every real turn. */
  readonly mockState: string | null;
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
   * The settings this inspector may move, or null when it may move none.
   *
   * Exposed for the same reason `hub` is: everything this component does has to be drivable without
   * a window. It is what `shell.test.ts` uses to assert that a control actually reaches the coach —
   * the acceptance criterion of ADR-0037 — and what a headless `pnpm dev:replay` would use to sweep
   * a threshold across a fixture instead of editing `config.ts` between runs.
   */
  readonly controls: DebugControlPort | null;
  /**
   * The rehearsal port (ADR-0038), or null when this inspector has no mock states to run.
   *
   * Exposed for the same reason `controls` is: everything this component does has to be drivable
   * with no window. `shell.test.ts` uses it to assert that a rehearsal produces a turn and leaves
   * the live match's world, latches and ledger exactly where they were.
   */
  readonly rehearsal: DebugRehearsalPort | null;
  /** ADR-0039. Null means the window may display scenarios and not run them. */
  readonly actions: DebugActionPort | null;
  /** Idempotent: opening an already-open inspector focuses it rather than making a second one. */
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

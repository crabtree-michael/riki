/**
 * The vocabulary the main process and the **inspector** renderer both speak.
 *
 * The inspector is the dev-only window that answers *what does Riki currently believe, what did it
 * nearly say, and why did it stay quiet* — the questions the golden corpora in `fixtures/golden/`
 * can only answer about a moment somebody wrote down in advance — and, since ADR-0037, *what
 * happens if I move this number*. Its design is docs/design/debug-inspector.md.
 *
 * Three properties of this file are load-bearing:
 *
 * - **Everything here is structured-clone safe and self-describing.** No branded types, no `Map`,
 *   no class instances, no functions. A `DebugFrame` is built in main and read in a sandboxed
 *   renderer, and anything that needed a constructor on the far side would not survive the trip.
 * - **No union is restated from a package.** `suppressionReason`, `kind`, `staleness` and the rest
 *   are plain `string`, even though `@riki/events` and `@riki/world-model` have exact unions for
 *   them. `shared/` may not import `@riki/*` (eslint.config.js), so the alternative is a second
 *   copy of a thirteen-member union that must be kept in step by hand — and the inspector only
 *   ever *renders* these values, it never switches on them. `hub.test.ts` asserts that every
 *   member of the real unions can reach a frame, which is the check a copied union would only
 *   look like it was providing.
 * - **A frame is a projection, not a log.** Everything in it is bounded: the ring buffers are
 *   capped in `main/debug/hub.ts`, and the two text fields that can be long are truncated there.
 *   A window left open for a whole match must not grow without limit.
 *
 * ## What is deliberately not here
 *
 * **The player's own words.** `DebugTurn.playerSaid` carries a character count and never the
 * transcript. Everything else in a frame is either a fact Riki derived, or text Riki itself
 * composed and was about to send to a model — the player's speech is neither, and it is the one
 * thing in this process that is nobody's business but theirs (dota2 §7). The coach's transcript
 * *is* carried: "what did it actually say" is half the reason this window exists.
 *
 * ⚠ Same transitional note as `shared/overlay.ts`: this crosses a process boundary, so by
 * REPO_SKELETON.md §4 it belongs in `@riki/protocol` as zod schemas once that package lands. It is
 * listed second there rather than first — the inspector is dev-only and never reaches Rust.
 */

/** Milliseconds on main's monotonic clock. Only ever compared with another number from the same frame. */
export type DebugMillis = number;

// -----------------------------------------------------------------------------------------------
// The frame
// -----------------------------------------------------------------------------------------------

/**
 * One complete answer to "what is going on", pushed on a timer while the window is open.
 *
 * A whole frame rather than a delta stream, and that is a deliberate trade: a frame is a few
 * kilobytes at 4 Hz, and the alternative — patches the renderer applies to state it holds — means
 * the inspector has its own copy of the model it exists to inspect, which is the one bug class a
 * debug tool must not have.
 */
export interface DebugFrame {
  /** Monotonic. The renderer drops a frame older than the one it has drawn. */
  readonly revision: number;
  readonly at: DebugMillis;
  readonly session: DebugSession;
  readonly world: DebugWorld;
  /** Newest last. Capped; see `DEBUG_LIMITS`. */
  readonly ticks: readonly DebugTick[];
  readonly turns: readonly DebugTurn[];
  readonly counters: DebugCounters;
  readonly problems: readonly DebugProblem[];
  /**
   * Every setting the window may move, with its current value — see `DebugControl`.
   *
   * In the frame rather than fetched once on mount, because a control's value can change without
   * the window asking: `coach.mode` degrades to `static` when `llm` has no key behind it, and both
   * coach controls are also driven from the tray. A list that were cached in the renderer would
   * disagree with the app the first time either happened, and a control that lies about its own
   * value is worse than no control.
   */
  readonly controls: readonly DebugControl[];
}

// -----------------------------------------------------------------------------------------------
// Session — the app, not the game
// -----------------------------------------------------------------------------------------------

export interface DebugSession {
  readonly matchId: string | null;
  /**
   * Whether a `MatchRuntime` exists (shell/index.ts, "Two lifetimes").
   *
   * Separate from `matchId !== null` on purpose: they disagree exactly when something is wrong,
   * and that disagreement is invisible from anywhere else.
   */
  readonly coachingRoot: boolean;
  /** `MachineState.phase.kind` — idle, armed, listening, processing, speaking, error. */
  readonly chipPhase: string;
  readonly chipVisible: boolean;
  readonly muted: boolean;
  /**
   * `static` | `llm` — which coach is answering *should Riki speak right now* (ADR-0031).
   *
   * It changes what the rest of a frame can contain, so it is at the top rather than buried in the
   * counters. Under `static` a tick carries candidates and a thirteen-gate grid; under `llm` there
   * is no ladder at all — a model read the world and either proposed a line or declined with a
   * sentence — so a tick carries a decision and nothing else, and `DebugGateState` and
   * `DebugCounters` are empty because `packages/events` is not running.
   */
  readonly coachMode: string;
  readonly gates: DebugGateState;
  readonly health: DebugHealth;
}

/**
 * The five pieces of engine state no gate result can be read without.
 *
 * `latched` and `kindCooldowns` are the two that cost the most time to guess at: a trigger refused
 * as `latched` looks identical to one refused as `kind_cooldown` from the outside, and neither is
 * reachable from `TriggerCounters`.
 */
export interface DebugGateState {
  /**
   * The tick this state was read from, or null before the engine has run one.
   *
   * It is **not** `DebugFrame.at`. The engine's private state is only visible when it assembles a
   * `GateContext`, which happens on a world-model version bump — so between bumps these numbers are
   * a still frame, and a cooldown's `remainingMs` has stopped counting down. Carried so the
   * inspector can say that rather than quietly presenting stale numbers as live.
   */
  readonly asOfMs: DebugMillis | null;
  readonly quietMode: boolean;
  readonly agentSpeaking: boolean;
  readonly playerSpeaking: boolean;
  /** Monotonic instant the mute expires, or null. Compare against `DebugFrame.at`. */
  readonly mutedUntilMs: DebugMillis | null;
  /** `config.unprompted` — the setting behind `setQuietMode` at match open. */
  readonly unprompted: boolean;
  /** 0..1, the `high_intensity` input, as of the last tick. */
  readonly intensity: number;
  readonly intensityThreshold: number;
  readonly speakThreshold: number;
  readonly lastSpokeAtMs: DebugMillis | null;
  readonly globalCooldownMs: number;
  /** Detection keys currently latched, e.g. `enemy_missing:sf`. */
  readonly latched: readonly string[];
  readonly kindCooldowns: readonly DebugCooldown[];
}

export interface DebugCooldown {
  readonly kind: string;
  /** Milliseconds still to run. Zero or less means the cooldown is spent. */
  readonly remainingMs: number;
}

export interface DebugHealth {
  /** `full` | `no_vlm` | `no_scoreboard` | `no_topbar` | `gsi_only`. */
  readonly level: string;
  readonly summary: string;
  readonly sources: readonly DebugSource[];
  readonly bus: DebugBus;
}

export interface DebugSource {
  readonly id: string;
  /** `starting` | `live` | `degraded` | `down`. */
  readonly state: string;
  readonly reason: string | null;
  readonly lastObservationAgoMs: number | null;
  readonly restarts: number;
}

export interface DebugBus {
  readonly depth: number;
  readonly dropped: readonly DebugCount[];
  /** A `seq` that went backwards or skipped, per source. A rising rate on the sidecar is a signal. */
  readonly gaps: readonly DebugCount[];
}

export interface DebugCount {
  readonly key: string;
  readonly count: number;
}

// -----------------------------------------------------------------------------------------------
// World — what the judge believes
// -----------------------------------------------------------------------------------------------

export interface DebugWorld {
  readonly version: number;
  /** Match clock in seconds, or null before the horn. Null is not zero. */
  readonly clock: number | null;
  readonly paused: boolean;
  /** How many versions the store has bumped since the window opened, and how fast. */
  readonly versionsPerSecond: number;
  /** One row per observed leaf, most interesting first. Never a bare value — see `DebugFact`. */
  readonly facts: readonly DebugFact[];
  readonly enemies: readonly DebugEnemy[];
  readonly derived: readonly DebugDerived[];
}

/**
 * A fact with its envelope, which is the whole point of `packages/world-model`.
 *
 * `value` is pre-rendered to a string in main rather than sent raw: the leaves are heterogeneous
 * (`{current, max}`, an array of abilities, a `MapPosition`), and a renderer that had to know how
 * to display each of them would be a second copy of the snapshot renderer.
 */
export interface DebugFact {
  /** The `FieldPath`, e.g. `self.health`. */
  readonly path: string;
  readonly value: string;
  /** `gsi` | `log` | `cv` | `api` | `derived`. */
  readonly source: string;
  readonly confidence: number;
  /** `fresh` | `aging` | `stale` | `expired`. */
  readonly staleness: string;
  readonly ageMs: number;
  /** `wall` | `game` — the two-clock rule, and the reason an age can look wrong during a pause. */
  readonly ageBasis: string;
}

export interface DebugEnemy {
  readonly hero: string;
  readonly staleness: string;
  readonly alive: boolean | null;
  readonly level: number | null;
  /** Rendered position, or null when never observed. Absent and unseen are different. */
  readonly position: string | null;
  readonly lastSeenAt: string | null;
  readonly itemsSeen: readonly string[];
}

export interface DebugDerived {
  readonly id: string;
  /** Null means the rule answered null — inputs too stale to answer honestly, not "zero". */
  readonly value: string | null;
  readonly confidence: number | null;
}

// -----------------------------------------------------------------------------------------------
// Ticks — the gate ladder, which is the thing that could not be seen before
// -----------------------------------------------------------------------------------------------

/**
 * One evaluation of the trigger policy, against one world-model version.
 *
 * `TriggerDecision` names the winner and the first gate that refused it. This names **every**
 * candidate and **every** gate's verdict on each, which is the difference between "Riki was quiet"
 * and "Riki was quiet because `ult_ready` outranked `rune_soon` and was then latched".
 */
export interface DebugTick {
  readonly seq: number;
  readonly at: DebugMillis;
  readonly clock: number | null;
  readonly worldVersion: number;
  /**
   * Ranked, highest salience first — the same order the policy sees.
   *
   * **Empty under the LLM coach**, and that is not a missing feature. `packages/coach` has no
   * detectors, no salience and no gate ladder: a model reads the world and either proposes a line
   * or declines with a sentence, so there is nothing to rank and nothing to grid. The `decision`
   * is the whole of what that coach can say about a moment it passed on.
   */
  readonly candidates: readonly DebugCandidate[];
  /** The wrapped policy's actual answer. Never computed here; always the value it returned. */
  readonly decision: DebugDecision;
}

export interface DebugCandidate {
  readonly kind: string;
  /** The latch key, e.g. `enemy_missing:sf`. */
  readonly key: string;
  readonly salience: number;
  readonly magnitude: number;
  readonly confidence: number;
  readonly actWithinSeconds: number | null;
  /** The detector's own words — what would reach the snapshot's `recent:` line. */
  readonly text: string;
  /** Whether this candidate cleared `tapeSalience` and was recorded. */
  readonly taped: boolean;
  /**
   * All thirteen, in ladder order, whether or not they fired.
   *
   * The ones that *passed* are as informative as the one that refused: a candidate that cleared
   * twelve gates and died on `below_threshold` is a tuning problem, and one that died on gate 1 is
   * not a coaching problem at all.
   */
  readonly ladder: readonly DebugGateVerdict[];
  /** `winner` for the ranked first, `ranked-below` for the rest. §5.5: there is no fall-through. */
  readonly rank: 'winner' | 'ranked-below';
}

export interface DebugGateVerdict {
  /** The `SuppressionReason`, e.g. `kind_cooldown`. */
  readonly reason: string;
  readonly refuses: boolean;
}

export type DebugDecision =
  | { readonly speak: true; readonly key: string }
  /**
   * `key` is null when the detectors produced nothing — not a refusal, and not counted as one.
   *
   * `reason` is a `SuppressionReason` from the deterministic coach and a **sentence** from the LLM
   * one, which is the same widening `CoachDriver.onDeclined` makes and for the same reason: the two
   * coaches do not owe each other a shared vocabulary for why they stayed quiet.
   */
  | { readonly speak: false; readonly reason: string; readonly key: string | null };

// -----------------------------------------------------------------------------------------------
// Turns — what the coach was given, and what became of it
// -----------------------------------------------------------------------------------------------

/**
 * One `openTurn` … `closeTurn`, with the text that was composed for it.
 *
 * This is the only place in the process where the snapshot and the brief can be read side by side
 * as they were actually rendered — the golden corpora render them for fixtures, and the ledger
 * keeps them but is not projected anywhere a human can see.
 */
export interface DebugTurn {
  readonly turnId: string;
  readonly at: DebugMillis;
  readonly clock: number | null;
  /** `trigger` | `player` | `system`. */
  readonly cause: string;
  /** The `CoachEvent.id` for a trigger turn; null for a player turn, which has no topic. */
  readonly eventId: string | null;
  readonly salience: number | null;
  readonly snapshotText: string;
  readonly snapshotTokens: number;
  readonly briefText: string;
  readonly briefTokens: number;
  readonly briefSections: readonly string[];
  /** Sections dropped by the budget or the confidence gate. A rising count means `BRIEF_PLAN` is wrong. */
  readonly briefOmitted: readonly string[];
  /** An empty brief is a turn that does not happen (coaching-architecture.md §6.5). */
  readonly briefEmpty: boolean;
  /** `open` until `closeTurn`, then `spoke` | `silent` | `cancelled`. */
  readonly outcome: string;
  /** What Riki actually said, once the final transcript arrives. Null while a turn is open. */
  readonly agentSaid: string | null;
  /**
   * The player's transcript is **not** carried; this is its length.
   *
   * Enough to tell "the transcript arrived and was empty" from "no transcript arrived", which is
   * the only thing about it this window needs to answer. See the header.
   */
  readonly playerSaidChars: number | null;
}

// -----------------------------------------------------------------------------------------------
// Counters and problems
// -----------------------------------------------------------------------------------------------

/** `TriggerCounters`, flattened for display, plus what the shell counts on top of it. */
export interface DebugCounters {
  readonly detected: readonly DebugCount[];
  readonly suppressed: readonly DebugCount[];
  readonly spoken: number;
  readonly emptyBriefs: number;
  readonly ticks: number;
}

/**
 * Something went wrong, from whichever subsystem noticed.
 *
 * Everything the shell's telemetry already reports as a fault lands here, because the alternative
 * — `nullTelemetry()` — is where all of it currently goes (`shell/telemetry.ts`). Until
 * `packages/telemetry` lands this window is the only place a sidecar panic or a renderer fault is
 * visible at all.
 */
export interface DebugProblem {
  readonly at: DebugMillis;
  /**
   * `sidecar` | `renderer` | `hotkey` | `source` | `world` | `coach` | `degradation` | `inspector`.
   *
   * The last is the inspector renderer reporting its own fault: it has no logger and may not import
   * `@riki/telemetry`, so the `fault` intent is the only way it can say anything went wrong.
   */
  readonly origin: string;
  readonly message: string;
}

// -----------------------------------------------------------------------------------------------
// Controls — the settings the window may move (ADR-0037)
// -----------------------------------------------------------------------------------------------

/**
 * The three value shapes a control can carry. Anything else would need a widget nobody has asked
 * for, and `blockedModes` and `escapeItems` — the two list-valued settings — are shown locked.
 */
export type DebugControlValue = boolean | number | string;

/**
 * One setting, described completely enough that the renderer needs no table of its own.
 *
 * **Self-describing on purpose.** The registry lives in `main/debug/controls.ts`, where it can be
 * derived mechanically from `TriggerConfig`, `COACH_EVENT_KINDS` and `GATES` — so a number added to
 * `packages/events/src/config.ts` fails the compiler there until it has a row, and appears in this
 * window with no renderer change at all. A second copy of that table over here is exactly the
 * hand-maintained duplicate the header's "no union is restated from a package" rule refuses.
 *
 * Every field is present and nullable rather than optional, for the same reason the panels never
 * infer: a control with no `min` and a control whose `min` did not survive the crossing should not
 * look the same.
 */
export interface DebugControl {
  /** Stable, e.g. `trigger.speakThreshold`, `gate.kind_cooldown`, `coach.mode`. */
  readonly id: string;
  /** Display grouping, e.g. `Coach`, `Thresholds`, `Gates`. Groups collapse independently. */
  readonly group: string;
  readonly label: string;
  readonly kind: 'boolean' | 'number' | 'enum';
  readonly value: DebugControlValue;
  /**
   * What the value would be with no override — the resolved config, not the shipped default.
   *
   * Shown beside an overridden value so a tuning session can always be read against what the app
   * would do on its own, and it is what `reset` restores.
   */
  readonly base: DebugControlValue;
  readonly overridden: boolean;
  /** Numbers only; null on the other kinds. `step` is also the stepper's increment. */
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
  /** `enum` only; empty otherwise. */
  readonly options: readonly string[];
  /** `ms`, `s`, `gold`, … — appended to the value, never parsed. */
  readonly unit: string | null;
  readonly note: string | null;
  /**
   * Non-null means **displayed and refused**, and this is the reason why.
   *
   * Shown rather than hidden deliberately. "Why can I not turn off the muted gate" is a question
   * the window should answer in place; a control that is simply absent invites somebody to add it.
   */
  readonly locked: string | null;
}

// -----------------------------------------------------------------------------------------------
// The bridge
// -----------------------------------------------------------------------------------------------

/** Bounds, in one place, so main and the renderer agree about what "recent" means. */
export const DEBUG_LIMITS = {
  ticks: 200,
  turns: 40,
  problems: 100,
  facts: 64,
  /** Snapshot and brief text, per turn. Generous — a snapshot is ~300 tokens by design. */
  textChars: 8_000,
  /** A control id and an enum value. Both are ours; the cap is against a malformed sender. */
  controlIdChars: 64,
  controlValueChars: 64,
} as const;

/** How often main pushes a frame while the window is open. 4 Hz reads as live and costs nothing. */
export const DEBUG_FRAME_INTERVAL_MS = 250;

export type DebugCommand =
  | { readonly kind: 'frame'; readonly frame: DebugFrame }
  /** The window is being torn down; stop drawing. */
  | { readonly kind: 'teardown' };

export type DebugIntent =
  /** Mounted, or remounted after a crash: main pushes a frame immediately. */
  | { readonly kind: 'ready' }
  /** The renderer has no logger and may not import @riki/telemetry; it reports through here. */
  | { readonly kind: 'fault'; readonly message: string }
  /**
   * Move one setting, by id (ADR-0037).
   *
   * The id is checked twice, and the two checks are different questions. Preload asks whether this
   * is *shaped* like a control intent, which is all it can know; main asks whether the id is a
   * **registered control that is not locked**, which is the check that actually decides anything.
   * An unrecognised id is recorded as an `inspector` problem rather than ignored — a control that
   * silently does nothing is the failure this window exists to make impossible.
   */
  | { readonly kind: 'control'; readonly id: string; readonly value: DebugControlValue }
  /** Drop every override at once, so a tuning session has a way back to the resolved config. */
  | { readonly kind: 'reset-controls' };

/**
 * The inspector renderer's entire view of the outside world, as `window.rikiDebug`.
 *
 * **It can now change what the app does, and only through here.** Until ADR-0037 this bridge had
 * two members and neither reached anything mutable; the window it exposes made the thresholds in
 * `packages/events/src/config.ts` visible and left "so what happens if I move this" as a rebuild.
 * The answer is a fourth member, `control`, and the property that replaces read-only-by-construction
 * is narrower and enforced in three places rather than assumed:
 *
 * - **Nothing changes unless a person clicks.** With no `control` intent the app behaves exactly as
 *   it does with the window shut, which is what `shell.test.ts` asserts by replaying a fixture with
 *   the flag off and on and comparing the utterances.
 * - **The reachable set is a registry, not a surface.** `control` names an id from a table in
 *   `main/debug/controls.ts`; there is no path from here to an arbitrary field, and no `evaluate`,
 *   no `speak`, no "replay this tick".
 * - **The player's own instructions are not in the table.** The `quiet_mode` and `muted` gates are
 *   locked, and mute keeps the one producer ADR-0028 gave it.
 */
export interface RikiDebugBridge {
  onCommand(fn: (command: DebugCommand) => void): () => void;
  send(intent: DebugIntent): void;
}

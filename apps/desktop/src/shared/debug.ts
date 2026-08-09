/**
 * The vocabulary the main process and the **inspector** renderer both speak.
 *
 * The inspector is the dev-only window that answers *what does Riki currently believe, what was it
 * given for a turn, and what did it say* — the questions the golden corpora in `fixtures/golden/`
 * can only answer about a moment somebody wrote down in advance. Its design is
 * docs/design/debug-inspector.md.
 *
 * ⚠ **Mid-migration.** ADR-0042 deleted the trigger engine, and with it the gate ladder that was
 * this window's centre of gravity. The Triggers, Gate state, Counters, Controls and Rehearsal panels
 * every one observed something that no longer exists, so they are gone rather than empty — a panel
 * that renders "0 of 13 gates" against no engine is worse than an absent one. Their replacement is a
 * per-turn tool trace (conversational-architecture.md §10), and that is T9 of the migration rather
 * than this file's current contents.
 *
 * Three properties of this file are load-bearing:
 *
 * - **Everything here is structured-clone safe and self-describing.** No branded types, no `Map`,
 *   no class instances, no functions. A `DebugFrame` is built in main and read in a sandboxed
 *   renderer, and anything that needed a constructor on the far side would not survive the trip.
 * - **No union is restated from a package.** `staleness`, `source` and the rest are plain `string`,
 *   even though `@riki/world-model` has exact unions for them. `shared/` may not import `@riki/*`
 *   (eslint.config.js), so the alternative is a copy that must be kept in step by hand — and the
 *   inspector only ever *renders* these values, it never switches on them. `hub.test.ts` asserts
 *   that every member of the real unions can reach a frame, which is the check a copied union would
 *   only look like it was providing.
 * - **A frame is a projection, not a log.** Everything in it is bounded: the ring buffers are
 *   capped in `main/debug/hub.ts`, and the long text fields are truncated there. A window left open
 *   for a whole match must not grow without limit.
 *
 * ## What is deliberately not here
 *
 * **The player's own words.** `DebugTurn.playerSaidChars` carries a character count and never the
 * transcript. Everything else in a frame is either a fact Riki derived, or text Riki itself
 * composed and was about to send to a model — the player's speech is neither, and it is the one
 * thing in this process that is nobody's business but theirs (dota2 §7). Riki's own transcript *is*
 * carried: "what did it actually say" is half the reason this window exists.
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
  readonly turns: readonly DebugTurn[];
  readonly problems: readonly DebugProblem[];
  /** Every scenario the window may run — see `DebugAction` (ADR-0039). */
  readonly actions: readonly DebugAction[];
  /**
   * The turn chain in order, newest last. Capped; see `DEBUG_LIMITS`.
   *
   * The one panel that is a *sequence* rather than a state. Every other panel answers "what is true
   * now", and the failure that motivated ADR-0039 was invisible to all of them because the question
   * worth asking was "what happened, in order, and where did it stop".
   */
  readonly trace: readonly DebugTraceStep[];
}

// -----------------------------------------------------------------------------------------------
// Session — the app, not the game
// -----------------------------------------------------------------------------------------------

export interface DebugSession {
  readonly matchId: string | null;
  /**
   * Whether the shell has opened a Realtime session for this match (shell/index.ts, "Two lifetimes").
   *
   * Separate from `matchId !== null` on purpose: they disagree exactly when something is wrong —
   * `match_started` reaching the state subsystem and not the shell — and that disagreement is
   * invisible from anywhere else.
   */
  readonly matchSession: boolean;
  /** `MachineState.phase.kind` — idle, armed, listening, processing, speaking, error. */
  readonly chipPhase: string;
  readonly chipVisible: boolean;
  readonly muted: boolean;
  readonly health: DebugHealth;
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
// World — what the model believes
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
// Turns — what the model was given, and what became of it
// -----------------------------------------------------------------------------------------------

/**
 * One question, with the text that was composed to answer it.
 *
 * This is the only place in the process where the snapshot can be read as it was actually rendered:
 * the golden corpora render it for a fixture, and nothing keeps the live one.
 *
 * It used to carry the coaching brief and the LLM coach's drafted line beside the snapshot, and a
 * `mockState` for a rehearsed turn. ADR-0042 deleted all three. What belongs in their place is the
 * tool calls the model made to answer — T9 of the migration — so a turn today is a snapshot, an
 * outcome and a transcript.
 */
export interface DebugTurn {
  readonly turnId: string;
  readonly at: DebugMillis;
  readonly clock: number | null;
  /** `player` | `system`. Every real turn is `player`; `scenario.speak` is `system`. */
  readonly cause: string;
  readonly snapshotText: string;
  readonly snapshotTokens: number;
  /**
   * Sections the model did not get, whatever the reason.
   *
   * A section the world model could not satisfy and one the budget dropped are both here, which is
   * the renderer's own rule (`packages/context`): somebody reconciling a turn against a fixture
   * should not have to know which happened, only that the line is not there.
   */
  readonly snapshotOmitted: readonly string[];
  /** `open` until the turn resolves, then `spoke` | `cancelled`. */
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
// Problems
// -----------------------------------------------------------------------------------------------

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
   * `sidecar` | `renderer` | `hotkey` | `source` | `world` | `degradation` | `inspector`.
   *
   * The last is the inspector renderer reporting its own fault: it has no logger and may not import
   * `@riki/telemetry`, so the `fault` intent is the only way it can say anything went wrong.
   */
  readonly origin: string;
  readonly message: string;
}

// -----------------------------------------------------------------------------------------------
// Actions and the trace — what the window may run, and what it produced (ADR-0039)
// -----------------------------------------------------------------------------------------------

/**
 * One runnable scenario.
 *
 * The only thing in this window that *does* something. ADR-0037 admitted settings the window could
 * move and refused actions in the same breath; ADR-0039 reversed the second half, and ADR-0042 then
 * removed every setting there was to move — the whole registry described `packages/events`'
 * thresholds and gates. So an action is now the only intent with a consequence, which makes the
 * `id`-is-a-registry-row rule below the whole of this window's write surface.
 */
export interface DebugAction {
  /** Stable: `scenario.match`, `scenario.speak`. */
  readonly id: string;
  readonly group: string;
  readonly label: string;
  /** What it will do, and what it costs — `scenario.speak` spends an API call per press. */
  readonly note: string;
  /**
   * True while a run is in flight. The renderer draws the row disabled.
   *
   * Main refuses a second run of the same id anyway; this is so the window says why rather than
   * appearing to ignore the click.
   */
  readonly running: boolean;
  /** How the last run ended, or null if it has not been run. Cleared when a new run starts. */
  readonly lastOutcome: string | null;
}

/**
 * One step of the turn chain.
 *
 * `stage` is a coarse bucket the renderer colours by; `message` is the line. Both are built in main
 * — the renderer formats nothing, for the same reason the panels never infer.
 */
export interface DebugTraceStep {
  readonly at: DebugMillis;
  /** Monotonic within the app's run, so the renderer can key rows without comparing timestamps. */
  readonly seq: number;
  /** `turn` | `snapshot` | `session` | `renderer` | `scenario` | `fault`. */
  readonly stage: string;
  readonly message: string;
  /**
   * Milliseconds since the run that produced this step began, or null outside a run.
   *
   * A wall-clock time answers "when"; this answers "how long after the trigger", which is the
   * question a chain that stalls actually poses.
   */
  readonly sinceRunMs: DebugMillis | null;
}

// -----------------------------------------------------------------------------------------------
// The bridge
// -----------------------------------------------------------------------------------------------

/** Bounds, in one place, so main and the renderer agree about what "recent" means. */
export const DEBUG_LIMITS = {
  turns: 40,
  problems: 100,
  facts: 64,
  /** Snapshot text, per turn. Generous — a snapshot is ~300 tokens by design. */
  textChars: 8_000,
  /** An action id. It is ours; the cap is against a malformed sender. */
  actionIdChars: 64,
  /**
   * Trace steps kept (ADR-0039).
   *
   * A single `scenario.match` run produces roughly a dozen; 200 is several runs plus whatever the
   * live app contributed between them, and it is a ring buffer rather than a log — the point is the
   * last thing that happened, not the session's history.
   */
  trace: 200,
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
   * Run one scenario, by id (ADR-0039).
   *
   * The id is checked twice, and the two checks are different questions. Preload asks whether this
   * is *shaped* like an action intent, which is all it can know; main asks whether the id is a
   * **registered action that is not already running**, which is the check that actually decides
   * anything. An unrecognised id is recorded as an `inspector` problem rather than ignored — a
   * button that silently does nothing is the failure this window exists to make impossible.
   */
  | { readonly kind: 'action'; readonly id: string }
  /** Drop the trace ring buffer, so the next run reads from an empty panel. */
  | { readonly kind: 'clear-trace' };

/**
 * The inspector renderer's entire view of the outside world, as `window.rikiDebug`.
 *
 * **It can change what the app does, and only through one intent.** `action` is the whole of the
 * write surface: `scenario.match` drives the real chain by posting GSI frames at our own server, and
 * `scenario.speak` reaches the session port (ADR-0039).
 *
 * ADR-0037's `control` and ADR-0038's `rehearse` are both gone, and neither is deferred: every row
 * in the control registry described a threshold or a gate in `packages/events`, and a rehearsal ran
 * one coach turn against a mock world. ADR-0042 deleted the engine and both coaches, so the two
 * intents named things that no longer exist.
 *
 * - **Nothing changes unless a person clicks.** With no `action` intent the app behaves exactly as
 *   it does with the window shut, which is what `shell.test.ts` asserts by replaying a fixture with
 *   the flag off and on and comparing the result.
 * - **The reachable set is a registry, not a surface.** `action` names an id from a table in
 *   `main/debug/actions.ts`; there is no path from here to an arbitrary field or an arbitrary file.
 * - **The player's own instructions are not in the table.** Mute keeps the one producer ADR-0028
 *   gave it, and nothing here can reach it.
 */
export interface RikiDebugBridge {
  onCommand(fn: (command: DebugCommand) => void): () => void;
  send(intent: DebugIntent): void;
}

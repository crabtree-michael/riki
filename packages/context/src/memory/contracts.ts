/**
 * The memory layer: the ledger, its projections, and the window policy over it.
 *
 * See docs/design/context-and-memory-architecture.md §6 and §7, and ADR-0012 and ADR-0013.
 * Declarations only.
 */

import type { GameClock, MatchId, MonoMs, TurnId } from '../common/types.js';
import type { WorldModelReader, WorldSnapshot } from '../common/ports.js';
import type { Budget, RenderedText } from '../render/types.js';
import type { ElisionBase } from '../snapshot/types.js';
import type {
  AdviceRecord,
  AdviceResponse,
  AdviceTopic,
  DropReason,
  LedgerEntry,
  LedgerRef,
  PlayerMemory,
  PlayerObservation,
  TurnOutcome,
  WindowBudget,
  WindowPlan,
  WindowState,
} from './types.js';

// -----------------------------------------------------------------------------------------------
// Working memory (§6.1)
// -----------------------------------------------------------------------------------------------

/**
 * The smallest span, and the only one the renderer touches.
 *
 * It holds no history of its own: every method is a lookup into the ledger or a cached projection
 * of it, which is what makes "what happens to working memory at compaction" a question with an
 * answer rather than a bug.
 */
export interface WorkingMemory {
  /** Null when elision is off, or when the base is no longer believed to be in the window (§5.3). */
  elisionBase(): ElisionBase | null;
  raised(topic: AdviceTopic): AdviceRecord | undefined;
  window(): WindowState;
  noteRendered(ref: LedgerRef): void;
  noteTurnClosed(turnId: TurnId, outcome: TurnOutcome): void;
}

// -----------------------------------------------------------------------------------------------
// The ledger (§6.2, ADR-0012)
// -----------------------------------------------------------------------------------------------

/**
 * Append-only, in memory, one per match. A whole match is a few hundred entries and a few tens of
 * kilobytes of text — this is not a data structure that needs care.
 *
 * `markDropped` never mutates an entry. Compaction changes what the *model* can see; it does not
 * change what happened, which is why every projection over the ledger survives it unchanged.
 */
export interface ConversationLedger {
  readonly matchId: MatchId;
  append(entry: LedgerEntry): LedgerRef;
  since(ref: LedgerRef): readonly LedgerEntry[];
  entry(ref: LedgerRef): LedgerEntry | undefined;
  /** What we believe the model can currently see. Maintained against the plan, reconciled in §7.6. */
  inWindow(): readonly LedgerRef[];
  markDropped(refs: readonly LedgerRef[], reason: DropReason): void;
  /** Monotonic; projections memoise against it, exactly as derived state does (state-capture §6). */
  version(): number;
}

/** The half of the ledger the session adapter needs. Separated so nothing else can append. */
export interface ConversationLedgerWriter {
  append(entry: LedgerEntry): LedgerRef;
  markDropped(refs: readonly LedgerRef[], reason: DropReason): void;
}

// -----------------------------------------------------------------------------------------------
// Coaching memory (§6.3)
// -----------------------------------------------------------------------------------------------

export interface CoachingMemory extends CoachingMemoryReader {
  all(): readonly AdviceRecord[];
  /** Derived from the world model, not from the conversation. See `AdviceResponse`. */
  observeOutcome(record: AdviceRecord, world: WorldSnapshot, now: MonoMs): AdviceResponse;
}

/**
 * What `packages/events` may see — three methods about advice, and nothing about tokens, the
 * window, or a `LedgerEntry`.
 *
 * This is the one edge between the two packages and it is a plain type import in the direction
 * events → context (§9.3). Giving the salience path a reason to know about tokens would be the same
 * inversion `agent-command-execution-architecture.md` §9.1 refused for commands.
 */
export interface CoachingMemoryReader {
  /** dota2 §6.4's novelty gate: don't repeat advice already acted on, or ignored twice. */
  recent(topic: AdviceTopic, within: number): AdviceRecord | undefined;
  lastSpokeAt(): GameClock | null;
  silentFor(now: GameClock): number;
}

// -----------------------------------------------------------------------------------------------
// Durable memory (§6.4, ADR-0013)
// -----------------------------------------------------------------------------------------------

export interface PlayerMemoryStore {
  /** Total: a missing, corrupt or version-mismatched file yields an empty memory, never an error. */
  load(): Promise<PlayerMemory>;
  record(observation: PlayerObservation): void;
  /** Batched — at match end and on a slow timer, never per observation. */
  flush(): Promise<void>;
  /** One settings button, one call. */
  forget(): Promise<void>;
}

// -----------------------------------------------------------------------------------------------
// The window policy (§7)
// -----------------------------------------------------------------------------------------------

/**
 * Pure: given what we believe is in the window and a budget, what should leave.
 *
 * The ladder (§7.2), least-valuable first — command results, then **the calls whose results were
 * dropped, always in the same plan**, then superseded snapshots, then old turns replaced by a
 * summary. The preamble, the manifest, the newest snapshot and the last `keepLastTurns` turns are
 * never dropped.
 *
 * The pairing rule is the one an implementation is most likely to get wrong by treating entries as
 * independent: dropping a result and keeping its call leaves the model looking at a question it
 * asked and never got an answer to, which is the vacuum the command architecture's §7.4 exists to
 * prevent, reintroduced by the retention policy.
 */
export interface RetentionPolicy {
  plan(ledger: ConversationLedger, budget: WindowBudget, now: MonoMs): WindowPlan;
}

/**
 * Decides *when*, which is a separate question from *what*.
 *
 * Not when the window is full: every truncation busts the prompt cache (realtime §5), and a cache
 * bust is a latency cost that lands on the player as a slow answer. So there is a low-water mark
 * and a preference for a quiet moment — and "quiet" needs no new dependency, because the world
 * model's derived state already knows about teamfight intensity, the same signal `packages/events`
 * uses to suppress speech.
 */
export interface Compactor {
  /** Called on turn close, never on turn open. Cheap, and usually null. */
  consider(world: WorldSnapshot, now: MonoMs): WindowPlan | null;
  /** After `packages/realtime` confirms execution. Updates `inWindow()` and the elision base. */
  applied(plan: WindowPlan, dropped: readonly LedgerRef[]): void;
}

/**
 * Summaries are **rendered, not generated** (§7.4).
 *
 * Riki is in an unusual position: the thing being summarised is already structured. The world model
 * holds the kills, objectives, item timings and net-worth curve; the ledger holds every piece of
 * advice given and whether it was followed. So the summary costs no tokens and no latency, cannot
 * invent a kill, is golden-testable as a diff, and works when the session is already unhealthy —
 * which is exactly when compaction tends to be needed.
 */
export interface SummaryRenderer {
  render(entries: readonly LedgerEntry[], world: WorldModelReader, budget: Budget): RenderedText;
}

/**
 * Reconnect (§7.5). A dropped or expired session is a normal event in a long match — Riki's window
 * fills in ~38 minutes (§7.1) and the API caps a session at 60.
 *
 * The brief carries the match summary so far, every advice topic already raised (so Riki does not
 * repeat twenty minutes of coaching), and the last few turns' gist. Audio is never replayed; the
 * recorded transcripts are the record.
 */
export interface Rehydrator {
  brief(ledger: ConversationLedger, world: WorldSnapshot, budget: Budget): RenderedText;
}

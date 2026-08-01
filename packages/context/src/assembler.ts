/**
 * The one thing this package exports at runtime.
 *
 * Three tiers of context and four spans of memory meet here, and the reason they meet in one object
 * is that they share two budgets: the 16,384-token cached prefix (Tier 1 + the Tier 3 manifest,
 * §4.2) and the ~28,672-token conversation window (Tier 2 + Tier 3 results + the conversation,
 * §7.1). Nobody can enforce a ceiling on a resource they can only see a third of.
 *
 * See docs/design/context-and-memory-architecture.md §9.4. Declarations only.
 */

import type { MonoMs, TurnId } from './common/types.js';
import type { Budget, RenderedText } from './render/types.js';
import type { Preamble, PreambleInput, PrefixBudget } from './preamble/types.js';
import type { RenderedSnapshot, TurnBrief } from './snapshot/types.js';
import type { TurnOutcome } from './memory/types.js';
import type { ConversationLedgerWriter, CoachingMemoryReader } from './memory/contracts.js';
import type { ToolManifest } from './tools/contracts.js';

/** What the session is opened with. Frozen for the match (§4.4, ADR-0011). */
export interface SessionContext {
  readonly preamble: Preamble;
  readonly manifest: ToolManifest;
  /** The sum nobody was computing: persona + preamble + manifest against the 16,384 cap (§4.2). */
  readonly prefix: PrefixBudget;
}

export interface TurnContext {
  readonly turnId: TurnId;
  readonly snapshot: RenderedSnapshot;
  /** What is left for command results this turn, after the snapshot (§7.1). */
  readonly remaining: Budget;
}

export interface ContextAssembler {
  /** Tier 1. Called once per match, before the session opens. */
  openSession(input: PreambleInput, deadline: MonoMs): Promise<SessionContext>;

  /** Tier 2. Synchronous and budgeted under 5 ms — this is the hot path (§5.4). */
  openTurn(brief: TurnBrief, now: MonoMs): TurnContext;

  /**
   * Where compaction is considered (§9.2). At turn *open* it would add latency to the path the
   * 5 ms and 100 ms budgets protect; at close there is nobody waiting.
   */
  closeTurn(turnId: TurnId, outcome: TurnOutcome, now: MonoMs): void;

  /** For `packages/events`. Read-only, and the only edge between the two packages (§9.3). */
  readonly coaching: CoachingMemoryReader;

  /** For the session adapter in the composition root: transcripts and command results in. */
  readonly ledger: ConversationLedgerWriter;

  /** After a lost session (§7.5). The preamble is re-assembled separately, byte-identically. */
  rehydrate(now: MonoMs): Promise<RenderedText>;
}

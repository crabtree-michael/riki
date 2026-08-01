/**
 * Tier 2 — the rolling snapshot (dota2-state-capture-design.md §6.2).
 *
 * ~250–400 tokens rendered from the world model at the moment a turn begins. This is the hot path
 * and the format is the interface to the LLM, so a change here is an API change: it goes through
 * `fixtures/golden/` and the diff is the review.
 *
 * See docs/design/context-and-memory-architecture.md §5. Declarations only.
 */

import type { EventId, GameClock, MonoMs, PrivacyPolicy, TurnId } from '../common/types.js';
import type { Budget, RenderedText, Section, SectionId } from '../render/types.js';

// -----------------------------------------------------------------------------------------------
// Why this turn exists (§3.3, §5.2)
// -----------------------------------------------------------------------------------------------

/**
 * The turn's cause is an input to the renderer, not just a label: it promotes exactly one section
 * (§5.2). A turn that exists because of `rune_soon` should not have the timings truncated out of it.
 */
export type TurnCause =
  | { readonly by: 'player'; readonly gesture: 'push_to_talk' | 'wake' }
  | { readonly by: 'trigger'; readonly event: EventId; readonly salience: number }
  | { readonly by: 'system'; readonly reason: 'match_started' | 'rehydrate' };

/** What `packages/events` hands over when it decides a turn should happen. */
export interface TurnBrief {
  readonly turnId: TurnId;
  readonly cause: TurnCause;
}

// -----------------------------------------------------------------------------------------------
// The event tape (§8.2)
// -----------------------------------------------------------------------------------------------

/**
 * Already natural language, from `packages/events` (dota2 §6.4). This package does not phrase
 * events — it places them, under a budget, and drops them first.
 */
export interface TapeEvent {
  readonly id: EventId;
  readonly at: GameClock;
  readonly text: string;
}

// -----------------------------------------------------------------------------------------------
// Rendering (§5.1)
// -----------------------------------------------------------------------------------------------

export interface SnapshotContext {
  readonly turnId: TurnId;
  readonly now: MonoMs;
  readonly cause: TurnCause;
  readonly budget: Budget;
  readonly privacy: PrivacyPolicy;
  readonly tape: readonly TapeEvent[];
  /** The elision base and what has already been said. Null disables elision for this turn (§5.3). */
  readonly elisionBase: ElisionBase | null;
}

export interface RenderedSnapshot extends RenderedText {
  readonly turnId: TurnId;
  readonly sections: readonly Section[];
  readonly truncated: boolean;
  /** What the budget or the confidence gate dropped. Telemetry, and asserted by golden tests. */
  readonly omitted: readonly SectionId[];
}

/**
 * The base an elided snapshot is a delta against — **specified, and off by default** (§5.3).
 *
 * A delta is only meaningful while its base is still in the model's context window, so elision is a
 * coupling to the retention policy rather than a formatting choice. It saves an estimated ~120
 * tokens on a ~300-token snapshot and costs a correctness dependency on our *estimate* of window
 * occupancy, which §12 lists as unverified. Turn it on when that estimate has been measured.
 *
 * `clock` is rendered into the marker — `(unchanged since 14:12)` rather than a bare
 * `(unchanged)` — so that a model whose base was truncated sees a reference to a time it has no
 * record of, which is a question it can ask, instead of a claim it cannot check.
 */
export interface ElisionBase {
  readonly rendered: RenderedSnapshot;
  readonly clock: GameClock | null;
}

// -----------------------------------------------------------------------------------------------
// The section ladder (§5.2)
// -----------------------------------------------------------------------------------------------

/** One per line group of dota2 §6.2's format. Ordering and droppability are §5.2's table. */
export type SnapshotSectionId =
  | 'header'
  | 'self_economy'
  | 'self_abilities'
  | 'self_items'
  | 'enemies'
  | 'seen'
  | 'unseen'
  | 'derived'
  | 'map'
  | 'recent';

/**
 * Declared data, not the order of statements in a function. A section with no entry here is a
 * section that truncates in whatever order an array happened to be in.
 */
export interface LadderEntry {
  readonly id: SnapshotSectionId;
  readonly priority: number;
  readonly droppable: boolean;
  /**
   * Sections that must drop together. `seen` and `unseen` are the pair that matters:
   * `unseen >20s: ws, zeus` alone reads as a complete account of where the enemy team is, which is
   * the opposite of what it says.
   */
  readonly dropsWith?: readonly SnapshotSectionId[];
}

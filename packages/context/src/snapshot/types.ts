/**
 * Tier 2 — the rolling snapshot (dota2-state-capture-design.md §6.2).
 *
 * ~250–400 tokens rendered from the world model at the moment a turn begins. This is the hot path
 * and the format is the interface to the LLM, so a change here is an API change: it goes through
 * `fixtures/golden/` and the diff is the review.
 *
 * See docs/design/context-and-memory-architecture.md §5. Declarations only.
 */

import type { MonoMs, PrivacyPolicy, TurnId } from '../common/types.js';
import type { Budget, RenderedText, Section, SectionId } from '../render/types.js';

// -----------------------------------------------------------------------------------------------
// Why this turn exists (§3.3, §5.2)
// -----------------------------------------------------------------------------------------------

/**
 * The turn's cause.
 *
 * It used to have a third arm — `{ by: 'trigger', event, salience }` — and the renderer used it to
 * promote exactly one section up the ladder, on the argument that a turn which exists because of
 * `rune_soon` should not have the timings truncated out of it. ADR-0042 deleted the thing that
 * produced it: with no trigger there is no event to promote for, and every turn now exists because
 * somebody pressed the key. The ladder is therefore fixed, which is one fewer thing that can make
 * two identical worlds render differently.
 */
export type TurnCause =
  | { readonly by: 'player'; readonly gesture: 'push_to_talk' | 'wake' }
  | { readonly by: 'system'; readonly reason: 'match_started' | 'rehydrate' };

/** What the composition root hands over when a turn begins. */
export interface TurnBrief {
  readonly turnId: TurnId;
  readonly cause: TurnCause;
}

// -----------------------------------------------------------------------------------------------
// Rendering (§5.1)
// -----------------------------------------------------------------------------------------------

export interface SnapshotContext {
  readonly turnId: TurnId;
  readonly now: MonoMs;
  readonly cause: TurnCause;
  readonly budget: Budget;
  /**
   * Carried even though **no section currently consults it**, and that is deliberate.
   *
   * The `recent:` line was the one place other players' words could reach a third-party API, and it
   * went with the event tape that fed it (ADR-0042); every field the nine remaining sections render
   * classifies as `game_state`, so the gate has nothing to refuse. It stays on the context rather
   * than being removed because the gate is the *second* of the two independent defences
   * REPO_SKELETON.md §7.2 requires — the first is at the source — and the next section anybody adds
   * that renders a name or a line of chat must go through `render/privacy.ts` rather than
   * reintroducing the policy alongside it.
   */
  readonly privacy: PrivacyPolicy;
}

export interface RenderedSnapshot extends RenderedText {
  readonly turnId: TurnId;
  readonly sections: readonly Section[];
  readonly truncated: boolean;
  /** What the budget or the confidence gate dropped. Telemetry, and asserted by golden tests. */
  readonly omitted: readonly SectionId[];
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
  | 'map';

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

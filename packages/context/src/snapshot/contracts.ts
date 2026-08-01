/**
 * The Tier 2 renderer and the pieces it composes.
 *
 * Budgeted at under 5 ms, model → snapshot (dota2 §6, the `agent-context` skill). The budget is not
 * about throughput — this runs once a turn — it is about keeping game arithmetic on the other side
 * of the world model's boundary. Anything expensive belongs in `DerivedView`, computed once and
 * memoised per version (state-capture §6), not here.
 *
 * See docs/design/context-and-memory-architecture.md §5. Declarations only.
 */

import type { EventId } from '../common/types.js';
import type { WorldSnapshot } from '../common/ports.js';
import type { Section } from '../render/types.js';
import type { LadderEntry, RenderedSnapshot, SnapshotContext, SnapshotSectionId } from './types.js';

/**
 * Pure and synchronous. Given the same world snapshot and the same context it renders the same
 * text, which is what makes `fixtures/golden/snapshot/` a meaningful diff.
 */
export interface SnapshotRenderer {
  render(world: WorldSnapshot, ctx: SnapshotContext): RenderedSnapshot;
}

/**
 * One per line group, one file each. A source produces a section or nothing; it never decides
 * whether the section survives the budget, and it never formats an age itself — `AgeFormatter` is
 * the only thing that turns an `Observed<T>` into words.
 *
 * Returning `null` rather than an empty section matters: an empty `seen:` line and an absent one
 * say different things, and dota2 §6.2's rule is that a missing field is never acceptable but a
 * dropped section is, provided `omitted` records it.
 */
export interface SectionSource {
  readonly id: SnapshotSectionId;
  build(world: WorldSnapshot, ctx: SnapshotContext): Section | null;
}

/**
 * The truncation order, as data.
 *
 * `promote` is §5.2's one-section rule: the turn's cause moves exactly one section up the ladder,
 * chosen by a lookup table from `EventId`, so ordering stays a golden-testable fact rather than a
 * scoring function nobody can predict.
 */
export interface PriorityLadder {
  readonly entries: readonly LadderEntry[];
  promote(cause: EventId): SnapshotSectionId | null;
  /** Expands a set of drops to include everything that must go with it (`dropsWith`). */
  closure(dropping: readonly SnapshotSectionId[]): readonly SnapshotSectionId[];
}

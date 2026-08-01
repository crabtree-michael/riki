/**
 * The brief renderer and the pieces it composes.
 *
 * Budgeted under the *same* <5 ms as the snapshot, not beside it (coaching-architecture.md §5.5).
 * The stronger form of that claim is the one to hold on to: **the brief must not be able to make a
 * turn slow.** The whole reason the deleted command pipeline needed a watchdog, a breaker and a
 * queue was that a command could reach a network. A brief that could reach a network would earn all
 * three back — which is why reference data lives in the preamble (§5.3) and why nothing here is
 * async.
 *
 * See docs/design/coaching-architecture.md §4.3 and §5.4. Declarations only.
 */

import type { WorldSnapshot } from '../common/ports.js';
import type { Section } from '../render/types.js';
import type { BriefContext, BriefRequest, BriefSectionId, CoachingBrief } from './types.js';

/**
 * Which sections this request needs, in priority order. **A lookup, not a scoring function.**
 *
 * The same argument as the snapshot's cause-driven promotion (context-and-memory §5.2): a table
 * keeps the resulting order a golden-testable fact, where a score makes "why did `pace` survive and
 * `positions` not" a question with a numeric answer nobody can predict from the fixture.
 */
export interface BriefPlanner {
  plan(req: BriefRequest): readonly BriefSectionId[];
}

/** Pure, synchronous, total. Given the same world and request it renders the same text. */
export interface BriefRenderer {
  render(world: WorldSnapshot, req: BriefRequest): CoachingBrief;
}

/**
 * One per section, one file each — the same shape as a snapshot `SectionSource`, and deliberately
 * a *separate* declaration rather than a shared one.
 *
 * A brief section is keyed by advice topic and ordered by what the trigger cares about; a snapshot
 * section is keyed by line group and ordered by a fixed ladder. Collapsing the two would carry a
 * per-cause priority concept into the snapshot, which has one cause-driven promotion and wants no
 * more.
 *
 * Returning `null` rather than an empty section matters for the same reason it does in Tier 2: an
 * absent section and an empty one say different things, and `omitted` has to be able to record
 * which happened. It matters *more* here, because a brief in which every section returns `null` is
 * a turn that does not happen at all (§6.5).
 */
export interface BriefSectionSource {
  readonly id: BriefSectionId;
  build(world: WorldSnapshot, ctx: BriefContext): Section | null;
}

/**
 * The coaching brief — a focused, budgeted rendering of the facts one piece of advice needs.
 *
 * Three steps, and the shape is deliberately simpler than the snapshot renderer's four:
 *
 * 1. Ask the plan which sections this cause wants, in priority order.
 * 2. Build them, assigning priority **from the plan's order** — position is priority, and the lead
 *    section is undroppable.
 * 3. Compose under the budget.
 *
 * There is no closure pass, and its absence is the point. Tier 2 needs one because `seen` and
 * `unseen` must drop together and the composer drops one section at a time; here that pair is a
 * single `positions` section, so a brief has **no rule where dropping one thing obliges dropping
 * another**. Same simplification the retention ladder got from the same deletion (§2.5).
 *
 * Pure, synchronous, and inside the snapshot's <5 ms budget rather than beside it (§5.5). Total:
 * nothing here throws, a section that cannot render is omitted and recorded, and a brief in which
 * nothing renders is `empty` rather than an exception (§6.5).
 *
 * See docs/design/coaching-architecture.md §4.3, §5.4, §5.5.
 */

import type { WorldSnapshot } from '../common/ports.js';
import type { Section, SectionId } from '../render/types.js';
import type { CoachingMemoryReader } from '../memory/contracts.js';
import type { BriefPlanner, BriefRenderer, BriefSectionSource } from './contracts.js';
import type { BriefContext, BriefRequest, BriefSectionId, CoachingBrief } from './types.js';
import { createSectionComposer } from '../render/compose.js';
import { ALL_BRIEF_SECTIONS } from './sections/index.js';
import { createBriefPlanner } from './plan.js';

export interface BriefRendererOptions {
  readonly sources?: readonly BriefSectionSource[];
  readonly planner?: BriefPlanner;
  /**
   * What Riki has already said. Injected rather than read, because `packages/events` holds the
   * same reader and the two must agree about what "the same advice" means (ADR-0013).
   */
  readonly coaching?: CoachingMemoryReader;
}

const composer = createSectionComposer();

export function createBriefRenderer(options: BriefRendererOptions = {}): BriefRenderer {
  const sources = options.sources ?? ALL_BRIEF_SECTIONS;
  const planner = options.planner ?? createBriefPlanner();
  const byId = new Map(sources.map((source) => [source.id, source]));

  return {
    render(world: WorldSnapshot, req: BriefRequest): CoachingBrief {
      const wanted = planner.plan(req);
      const ctx: BriefContext = { ...req, history: options.coaching ?? null };

      const built: Section[] = [];
      const missing: BriefSectionId[] = [];

      for (const [index, id] of wanted.entries()) {
        const section = byId.get(id)?.build(world, ctx) ?? null;
        if (section === null) {
          // Absent, not empty, and recorded either way: the golden corpus should show which of the
          // two happened, and a plan row naming a section nobody implements should be visible.
          missing.push(id);
          continue;
        }
        built.push({
          ...section,
          // Position is priority: earlier in the row survives longer. The lead section is what the
          // turn is *about*, so the budget may not eat it — a brief either carries the thing the
          // trigger fired on or renders nothing at all (§6.5), with no middle state where the model
          // is handed context for advice it can no longer justify.
          priority: wanted.length - index,
          droppable: index > 0,
        });
      }

      const composed = composer.compose(built, req.budget);
      const omitted = [...missing, ...composed.omitted.map((id) => String(id) as BriefSectionId)];

      return {
        turnId: req.turnId,
        text: composed.text,
        tokens: composed.tokens,
        sections: built.filter((section) => !composed.omitted.includes(section.id)),
        omitted,
        // The failure is a value. `packages/events` already admitted this turn, so the composition
        // root is the thing that has to act on it: an empty brief becomes `closeTurn('silent')`
        // rather than a session turn with nothing behind it and a model left to improvise.
        empty: composed.text === '',
      };
    },
  };
}

/** Convenience for a caller that only wants the ids, e.g. for a ledger entry. */
export function sectionIdsOf(brief: CoachingBrief): readonly BriefSectionId[] {
  return brief.sections.map((section) => String(section.id) as BriefSectionId);
}

/** Narrowing helper, so a caller reads a `SectionId` back as the union it came from. */
export function asBriefSectionId(id: SectionId): BriefSectionId {
  return String(id) as BriefSectionId;
}

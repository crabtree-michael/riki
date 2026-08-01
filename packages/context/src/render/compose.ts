/**
 * Assembling sections under a ceiling.
 *
 * Truncation is a design decision, not an accident, which is why `omitted` is part of the result
 * and part of the golden corpus: what survives a tight budget is reviewable as a diff rather than
 * discovered in a match.
 *
 * See docs/design/context-and-memory-architecture.md §5.2.
 */

import type { SectionComposer } from './contracts.js';
import type { Budget, Composed, Section, SectionId } from './types.js';
import { estimateTokens } from './tokens.js';

/** Joins section bodies. One line each: the LLM reads this, and blank lines are paid for. */
const SEPARATOR = '\n';

/**
 * Drops the lowest-priority droppable sections until the remainder fits.
 *
 * Two properties are load-bearing and are asserted by test:
 *
 * - **`droppable: false` sections are never dropped.** This is the structural form of dota2 §6.2's
 *   "self-state and enemy state never get truncated". If the undroppable set alone exceeds the
 *   budget the composer emits it anyway and reports `truncated` — failing loudly beats quietly
 *   producing a snapshot with no hero in it.
 * - **Order is by declared priority, never by statement order.** Lower priority drops first;
 *   output order follows the input array, so a drop does not reshuffle what remains.
 */
export function createSectionComposer(): SectionComposer {
  return {
    compose(sections: readonly Section[], budget: Budget): Composed {
      const available = budget.maxTokens - budget.spentTokens;
      const separatorCost = estimateTokens(SEPARATOR);

      const kept = new Set<Section>(sections);
      const omitted: SectionId[] = [];

      const cost = (): number => {
        let total = 0;
        let count = 0;
        for (const section of sections) {
          if (!kept.has(section)) continue;
          total += section.body.tokens;
          count += 1;
        }
        return total + Math.max(0, count - 1) * separatorCost;
      };

      // Cheapest-to-most-costly decision order: drop the least important thing that is allowed to
      // go, re-measure, repeat. Ties break toward later declaration, so a ladder with equal rungs
      // still degrades deterministically.
      const droppable = sections
        .filter((s) => s.droppable)
        .map((section, index) => ({ section, index }))
        .sort((a, b) =>
          a.section.priority === b.section.priority
            ? b.index - a.index
            : a.section.priority - b.section.priority,
        );

      let index = 0;
      while (cost() > available && index < droppable.length) {
        const next = droppable[index];
        index += 1;
        if (next === undefined) break;
        kept.delete(next.section);
        omitted.push(next.section.id);
      }

      const body = sections
        .filter((section) => kept.has(section))
        .map((section) => section.body.text)
        .join(SEPARATOR);

      const tokens = cost();
      return {
        text: body,
        tokens,
        truncated: omitted.length > 0 || tokens > available,
        omitted,
      };
    },
  };
}

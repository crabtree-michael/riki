/**
 * Selecting notes within one hero's entry. Pure, synchronous and total.
 *
 * There is deliberately no free-text ranking. A ranking pass existed first and was removed: over six
 * one-line notes it beat `topic` at nothing, and any query that missed degraded to priority order —
 * which is what this now does in one step (ADR-0027, rejected alternatives).
 *
 * See docs/design/hero-library.md §4.
 */

import type { HeroLibrary, HeroLibraryQuery, HeroLibraryResult } from './types.js';

/**
 * How many notes the search returns before the renderer's token budget gets involved.
 *
 * Six is far more than a brief will ever show — the `library` section renders one line per hero
 * against a ~150-token brief. The cap is here so the *function* is bounded for any caller, and the
 * section does the budgeting, which is where `coaching/render.ts` already does everyone else's.
 */
export const MAX_NOTES = 6;

/**
 * `undefined` means **this hero has no entry**, and it is the common answer rather than the edge
 * case: the library covers twenty heroes and a match contains ten. The `library` section renders
 * nothing for such a hero rather than saying it has nothing — a brief is not a conversation, so
 * there is nobody to apologise to (hero-library.md §4).
 */
export function searchHeroLibrary(
  library: HeroLibrary,
  query: HeroLibraryQuery,
): HeroLibraryResult | undefined {
  const found = library.entries.find((candidate) => candidate.hero === query.hero);
  if (found === undefined) return undefined;

  const topic = query.topic;
  const scoped = topic === undefined ? found.notes : found.notes.filter((n) => n.topic === topic);

  return {
    hero: found.hero,
    name: found.name,
    patch: library.patch,
    positions: found.positions,
    // The authored priority ladder, which is a coaching decision rather than a formatting one.
    notes: [...scoped].sort((a, b) => b.priority - a.priority).slice(0, MAX_NOTES),
  };
}

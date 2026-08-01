/**
 * Selecting notes within one hero's entry. Pure, synchronous and total.
 *
 * There is deliberately no free-text ranking here, and no `query` argument on the command that
 * calls it. A ranking pass existed first and was removed: over six one-line notes it beat `topic`
 * at nothing, and any query that missed degraded to priority order — which is what this now does in
 * one step. The reasoning is in the handler; the short version is that the shape ADR-0023 asks for
 * turned out to be the better one even though its egress argument does not bind a local reader.
 *
 * See docs/design/hero-library.md §4.
 */

import type { HeroLibrary, HeroLibraryQuery, HeroLibraryResult } from './types.js';

/**
 * How many notes the search returns before the renderer's token budget gets involved.
 *
 * Six, because the `reference` effect class allows 120 result tokens and a note is ~15–20 of them
 * (agent-command-execution-architecture.md §3.2). Returning more would hand the composer work whose
 * outcome is already decided — the extra notes are dropped before the model ever sees them.
 */
export const MAX_NOTES = 6;

/**
 * `undefined` means **this hero has no entry**, which is not the same as having nothing to say
 * about them: the library covers twenty heroes and a match contains ten, so the caller turns this
 * into `unavailable` and Riki says so plainly (hero-library.md §4).
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

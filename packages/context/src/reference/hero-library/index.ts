/**
 * The hero library — static coaching knowledge about the heroes that matter on this patch.
 *
 * Twenty heroes, six topics each, one line per note, written once and never refreshed (ADR-0023).
 * The agent reaches it through `search_hero_library`, which reaches it through `ReferenceDataPort`;
 * nothing here is pushed into a prompt or a preamble, so an uncalled library costs one manifest
 * entry and nothing else.
 *
 * `createStaticHeroLibrary()` is the whole runtime surface. It is the **first real implementation
 * of any part of `ReferenceDataPort`** — items, matchups and benchmarks are still fakes — which is
 * why it is a factory returning the port's method rather than a whole port: the composition root
 * assembles the real port from however many sources it ends up having.
 *
 * See docs/design/hero-library.md.
 */

import type { HeroLibrary, HeroLibraryQuery, HeroLibraryResult } from './types.js';
import type { ToolOutcome } from '../../tools/types.js';
import { HERO_LIBRARY } from './content/index.js';
import { failure, ok } from '../../tools/failures.js';
import { searchHeroLibrary } from './search.js';

export type * from './types.js';
export { HERO_LIBRARY, PATCH, AUTHORED } from './content/index.js';
export { searchHeroLibrary, MAX_NOTES } from './search.js';

/** Exactly the one method `ReferenceDataPort` gained for this. */
export interface HeroLibrarySource {
  heroLibrary(query: HeroLibraryQuery): Promise<ToolOutcome<HeroLibraryResult>>;
}

/**
 * A source over static content. Pure underneath, so it cannot time out, fail or be down.
 *
 * It still returns a `ToolOutcome` and still returns a promise, and both are deliberate: the port
 * is the seam a live implementation replaces (hero-library.md §6), and a seam whose static side
 * advertised "cannot fail" would have to change shape the day it stops being static.
 *
 * The one failure it does produce is real, and common: **a hero in the match with no entry**. With
 * twenty heroes covered and ten in a game, most heroes the agent asks about are not in here, so
 * that path is the normal case rather than the edge — hence a specific sentence rather than the
 * taxonomy's generic "I can't see that right now", which would be both wrong and worrying.
 */
export function createStaticHeroLibrary(library: HeroLibrary = HERO_LIBRARY): HeroLibrarySource {
  return {
    heroLibrary(query: HeroLibraryQuery): Promise<ToolOutcome<HeroLibraryResult>> {
      const found = searchHeroLibrary(library, query);
      return Promise.resolve(
        found === undefined
          ? failure('unavailable', {
              // Not `${query.hero}`: by this point the subject resolver has rewritten the argument
              // to a canonical id, and "I don't have notes on skeleton_king" is not a sentence a
              // coach says. The id stays in `detail`, which never reaches the model.
              speak: `I don't have notes on that hero.`,
              detail: `no library entry for ${String(query.hero)} (patch ${library.patch})`,
            })
          : ok(found),
      );
    },
  };
}

/**
 * `search_hero_library` — what a coach knows about a hero, as opposed to what the model can see.
 *
 * The world model knows what is happening. It does not know what *usually* happens: that Spectre is
 * weak before her second item, that Enigma's Black Hole goes through BKB. That is reference data in
 * the sense §5.3 already means — the data that is not about this match — so it arrives through
 * `ReferenceDataPort` and this handler holds no content of its own.
 *
 * `hero` is a `hero` subject, so it goes through the resolver and therefore through the **draft
 * check**. Asking about a hero who is not in the match answers `unknown_subject`, and that is
 * deliberate rather than incidental: at advice time the only heroes worth notes are the ten on the
 * map, and a library the agent can browse freely is an invitation to the untethered speculation
 * §4.3 exists to prevent.
 *
 * See docs/design/hero-library.md §4.
 */

import type { HeroId } from '../types.js';
import type { HeroLibraryResult } from '../../reference/hero-library/types.js';
import type { Part } from '../render.js';
import { HERO_TOPICS } from '../../reference/hero-library/types.js';
import { compose } from '../render.js';
import { defineArgs } from '../codec.js';
import { defineTool } from '../registry.js';

/**
 * Two arguments, both from closed sets. **There is no `query: string`, and that is deliberate.**
 *
 * ADR-0023 argues that shape out at length, and it is worth being precise about why it applies
 * here: its case is an *egress* one — a free-text argument is a channel out of the machine carrying
 * whatever the model decided to type — and it is `Proposed — deferred` along with the live design
 * it was written for. A static local reader sends nothing anywhere, so that argument does not bind
 * this command.
 *
 * The shape was kept anyway, because it is better on its own merits. A free-text ranking pass was
 * built here first and removed: over six one-line notes it beat `topic` at nothing, any query that
 * missed degraded to priority order — which is what the search now does in one step — and it
 * measured 33 tokens of permanent manifest cost. Keeping it also means that if the live design is
 * ever built, its vocabulary rule finds this command already compliant.
 *
 * Every word here is billed on every turn of the session, called or not (§8.1). This command
 * carries the manifest's only enum, which makes it its second most expensive entry, so the
 * descriptions are terse on purpose and `manifest.test.ts` holds the number as a ratchet.
 */
const args = defineArgs({
  hero: { kind: 'hero', description: 'A hero in this match.' },
  topic: { kind: 'enum', values: HERO_TOPICS, description: 'One kind of note.', optional: true },
});

/**
 * Above every note, and never dropped.
 *
 * The header confirms which hero the alias resolved to — the model says "sf", the resolver decides
 * that means Shadow Fiend, and without this line a wrong resolution reads as correct advice about
 * the wrong hero.
 */
function header(value: HeroLibraryResult): string {
  return `${value.name} (pos ${value.positions.join('/')})`;
}

export const searchHeroLibrary = defineTool({
  name: 'search_hero_library',
  effect: 'reference',
  summary:
    'Coaching notes on one hero: spikes, weaknesses, how to play against it. Top heroes only.',
  args,
  needs: ['reference'],

  handler: async (a, ctx) =>
    ctx.ports.reference.heroLibrary({
      hero: a.hero as HeroId,
      ...(a.topic === undefined ? {} : { topic: a.topic }),
    }),

  renderer: {
    render(value: HeroLibraryResult, ctx) {
      const notes: Part[] = value.notes.map((note, index) => ({
        // The index disambiguates: a hero has several `against` notes and `omitted` has to name
        // which one went, or the golden test asserts nothing.
        id: `${note.topic}.${String(index)}`,
        priority: note.priority,
        text: note.text,
      }));

      return compose(
        [
          { id: 'hero', priority: 1000, droppable: false, text: header(value) },
          ...notes,
          // Undroppable, for ~4 tokens. Nothing refreshes this content (ADR-0023), so the patch is
          // the whole difference between "notes written for 7.41e" and a claim about the game as it
          // is now — and the snapshot's rule against rendering a stale fact as a bare fact applies
          // to a note written eight months ago exactly as it applies to a CV sighting.
          { id: 'patch', priority: 0, droppable: false, text: `patch ${value.patch}` },
        ],
        ctx,
      );
    },
  },
});

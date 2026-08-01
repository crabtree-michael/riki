/**
 * The hero library — static coaching knowledge about the heroes that matter on this patch.
 *
 * Twenty heroes, six topics each, one line per note, written once and never refreshed (ADR-0027).
 * The brief reaches it through the `library` section (`../../coaching/sections/library.ts`); nothing
 * pushes it into a preamble, so a match in which none of the twenty is drafted renders none of it.
 *
 * **Pure, synchronous and total**, which is load-bearing rather than incidental.
 * `coaching/contracts.ts` states that the brief must not be able to make a turn slow, and that the
 * reason the deleted command pipeline needed a watchdog, a breaker and a queue was that a command
 * could reach a network. This is a frozen array and a `filter`, so a section may read it directly
 * without earning any of that back.
 *
 * See docs/design/hero-library.md.
 */

export type * from './types.js';
export { HERO_TOPICS } from './types.js';
export { HERO_LIBRARY, PATCH, AUTHORED } from './content/index.js';
export { searchHeroLibrary, MAX_NOTES } from './search.js';

/**
 * `library: Spectre — take objectives early, this game is decided before she comes online.
 *  | Enigma — do not fight without knowing where Blink is. | 7.41e`
 *
 * What a coach knows about a hero, as opposed to what the world model can see.
 *
 * Every other section renders something *observed*: a position, a net worth, a cooldown, each with
 * an age and a confidence. This one renders nothing observed at all. It is static content, authored
 * once against one patch and never refreshed (ADR-0027), and it is here because the world model
 * knows what is happening and does not know what *usually* happens — that Spectre is weak before
 * her second item, that Black Hole goes through BKB.
 *
 * Three consequences of that difference, all of which look like rule violations until you see why
 * they are not:
 *
 * - **No `field()`, and no age.** `util.ts` says a section never formats an age itself, and the
 *   mechanism is that `field()` is the only route from a value to the text. Nothing here is an
 *   `Observed<T>`, so there is no age to omit — and the honest equivalent, the **patch**, is
 *   rendered instead and is the last thing dropped.
 * - **Hero names come from the roster and the library, not from an observation.** Which heroes were
 *   drafted is known with certainty; `positions.ts` renders them as bare labels for the same
 *   reason.
 * - **No arithmetic**, same as everywhere. Which enemy matters most is a question about positions
 *   and movement speeds, which is `DerivedView`'s to answer and not this file's — so the ordering
 *   below *reads* `derived.threats` rather than computing anything.
 */

import type { HeroId } from '../../common/types.js';
import type { BriefSectionSource } from '../contracts.js';
import { HERO_LIBRARY, searchHeroLibrary } from '../../reference/hero-library/index.js';
import { join, line, path } from './util.js';

/**
 * How many heroes get a line.
 *
 * Two, and the constraint is the brief, not the library: at ~25 tokens a note against a ~150-token
 * budget for the whole brief, a third line is one that `render.ts` drops — after this section has
 * already spent the time composing it. Six notes per hero are available and one is shown, which is
 * the same ratio for the same reason.
 */
export const MAX_HEROES = 2;

/** `derived.threats`, as `threat.ts` reads it. Only the hero is used here. */
interface Threat {
  readonly hero: string;
}

/**
 * Enemies worth a note, most threatening first.
 *
 * `derived.threats` is the world model's answer to "who can reach the player", already scored and
 * memoised per version. Preferring it means the two heroes shown are the two the player is most
 * likely to be asking about, without this file comparing a single position to another.
 *
 * The fallback is roster order, which is arbitrary but deterministic — and arbitrary-but-covered
 * beats empty, because the alternative is a section that renders nothing in exactly the matches
 * where `derived.threats` has not been computed yet.
 */
function enemiesByThreat(
  enemies: readonly HeroId[],
  threats: readonly Threat[] | undefined,
): readonly HeroId[] {
  if (threats === undefined || threats.length === 0) return enemies;
  const rank = new Map(threats.map((t, index) => [t.hero, index]));
  return [...enemies].sort(
    (a, b) =>
      (rank.get(String(a)) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(String(b)) ?? Number.MAX_SAFE_INTEGER),
  );
}

export const library: BriefSectionSource = {
  id: 'library',

  // No `ctx`: this section reads no request field, because static content does not vary by cause.
  build(world) {
    const roster = world.roster();
    const threats = world.get<readonly Threat[]>(path('derived.threats'));

    const notes = enemiesByThreat(roster.enemies, threats?.value)
      // A hero the library does not cover contributes nothing and does not say so. With twenty
      // covered and ten drafted this is the common case, and "no notes on Pudge" is a sentence
      // about Riki rather than about the game — the brief is not a conversation and there is
      // nobody to apologise to.
      .map((hero) => searchHeroLibrary(HERO_LIBRARY, { hero, topic: 'counters' }))
      .filter((found) => found !== undefined)
      .slice(0, MAX_HEROES)
      // One note each, not one hero's six: two heroes at a line apiece is what a coach would
      // actually say, and it is what the budget allows.
      .map((found) => {
        const best = found.notes[0];
        return best === undefined ? null : `${found.name} — ${best.text}`;
      });

    const body = join(notes, ' | ');
    // The patch tag rides *inside* this section rather than being its own, so it cannot survive its
    // notes or outlive them. Nothing refreshes this content, so the tag is the whole difference
    // between "written for 7.41e" and a claim about the game as it is now — which is the snapshot's
    // rule against rendering a stale fact as a bare fact, applied to the axis that actually moves
    // in Dota.
    return line('library', 'library', body === null ? null : `${body} | ${HERO_LIBRARY.patch}`);
  },
};

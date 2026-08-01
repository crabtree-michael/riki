/**
 * `seen: sf bot 4s ago(0.91) · cm ward-ish mid 31s ago(0.55)`
 *
 * The first line in the snapshot that is a **hypothesis rather than a fact**, which is why it is the
 * first thing above `derived` that the budget is allowed to eat, and why every entry on it carries
 * an age and a confidence without exception. A position is almost always CV-derived, and dota2 §4
 * rule 3 names presenting one as certainty the worst outcome the product has.
 *
 * It drops with `unseen` — see `unseen.ts` for why that pairing is not a nicety.
 */

import type { HeroId } from '../../common/types.js';
import type { SectionSource } from '../contracts.js';
import { join, line, path, rendererFor } from './util.js';

/** dota2 §6.2's threshold, and `AgeFormatter`'s `unseenAfterMs`. One number, two lines. */
export const UNSEEN_AFTER_SECONDS = 20;

export const seen: SectionSource = {
  id: 'seen',

  build(world, ctx) {
    const field = rendererFor(world, ctx);
    const unseen = new Set(world.unseenFor(UNSEEN_AFTER_SECONDS).map(String));

    // Heroes on the `unseen` line are deliberately not on this one: saying where a hero was 40
    // seconds ago *and* that they have not been seen for 20 is two claims about the same hero, and
    // the model has to guess which to act on.
    const each = world
      .roster()
      .enemies.filter((hero: HeroId) => !unseen.has(String(hero)))
      .map((hero: HeroId) =>
        field(String(hero), world.get<string>(path(`enemies.${String(hero)}.area`))),
      );

    return line('seen', 'seen', join(each, ' · '));
  },
};

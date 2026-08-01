/**
 * `positions: seen sf bot 4s ago(0.91) · cm mid ~31s ago(0.55) | unseen >20s: ws, zeus`
 *
 * The lead section for `enemy_missing`, and **the two halves are one section on purpose.**
 *
 * In the snapshot these are two line groups, `seen` and `unseen`, held together by a `dropsWith`
 * entry on the ladder — because `unseen >20s: ws, zeus` on its own reads as a complete account of
 * where the enemy team is, which is the opposite of what it says. Here the pairing is structural:
 * one section cannot half-drop, so the budget can take both or neither and there is no closure rule
 * to get wrong. That is the same simplification the retention ladder got from deleting command
 * pairs — one fewer place where dropping one thing obliges dropping another.
 *
 * Everything on the `seen` half is a **hypothesis**: a position is almost always CV-derived, and
 * dota2 §4 rule 3 names presenting one as certainty the worst outcome the product has. Every entry
 * carries an age and a confidence without exception, because `field()` is the only way a value gets
 * onto the line.
 */

import type { HeroId } from '../../common/types.js';
import type { BriefSectionSource } from '../contracts.js';
import { fieldsFor, join, line, path } from './util.js';
// dota2 §6.2's threshold. **Imported, not re-declared**: it is also `AgeFormatter`'s
// `unseenAfterMs`, so a second copy here is a number that can drift from the one that decides
// whether a position renders as an age or as `unseen >Ns` — and the two would disagree silently.
import { UNSEEN_AFTER_SECONDS } from '../../snapshot/sections/seen.js';

export const positions: BriefSectionSource = {
  id: 'positions',

  build(world, ctx) {
    const field = fieldsFor(ctx, world.clock);
    const missing = world.unseenFor(UNSEEN_AFTER_SECONDS);
    const hidden = new Set(missing.map(String));

    // A hero on the unseen half is deliberately not on the seen half: saying where a hero was 40
    // seconds ago *and* that they have not been seen for 20 is two claims about the same hero, and
    // the model has to guess which to act on.
    const seen = join(
      world
        .roster()
        .enemies.filter((hero: HeroId) => !hidden.has(String(hero)))
        .map((hero: HeroId) =>
          field(String(hero), world.get<string>(path(`enemies.${String(hero)}.area`))),
        ),
      ' · ',
    );

    // Nothing here goes through `AgeFormatter`: the age *is* the label. `>20s` is a threshold, not
    // an observation, and there is no `Observed<T>` behind a hero being absent from a list.
    const unseen = missing.length === 0 ? null : missing.map(String).join(', ');

    return line(
      'positions',
      'positions',
      join([
        seen === null ? null : `seen ${seen}`,
        unseen === null ? null : `unseen >${String(UNSEEN_AFTER_SECONDS)}s: ${unseen}`,
      ]),
    );
  },
};

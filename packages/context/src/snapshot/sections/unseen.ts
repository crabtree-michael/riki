/**
 * `unseen >20s: ws, zeus` — treat as unknown, not absent.
 *
 * This line is the honest half of the pair, and on its own it is a lie. `unseen >20s: ws, zeus`
 * without the `seen:` line above it reads as *a complete account of where the enemy team is* — as
 * though the other three were accounted for — which is the opposite of what it says. §5.2 therefore
 * has the two drop together, expressed as `dropsWith` on the ladder rather than as a rule in the
 * renderer, so a future section that pairs with something else does not need the renderer changed.
 *
 * Nothing here goes through `AgeFormatter`: the age *is* the label. `>20s` is the threshold, not an
 * observation, and there is no `Observed<T>` behind a hero being missing from a list.
 */

import type { SectionSource } from '../contracts.js';
import { line } from './util.js';
import { UNSEEN_AFTER_SECONDS } from './seen.js';

export const unseen: SectionSource = {
  id: 'unseen',

  build(world) {
    const heroes = world.unseenFor(UNSEEN_AFTER_SECONDS);
    return line(
      'unseen',
      `unseen >${String(UNSEEN_AFTER_SECONDS)}s`,
      heroes.length === 0 ? null : heroes.map(String).join(', '),
    );
  },
};

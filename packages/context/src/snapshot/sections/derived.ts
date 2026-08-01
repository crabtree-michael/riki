/**
 * `buy: diffusal2 in ~40s | rosh window ~2:10 | rune 1:28 | nw lead us +3.1k`
 *
 * Pre-computed arithmetic — dota2 §6.2's "far better than making the model do gold math it will
 * sometimes get wrong". **Every number on this line was computed by `packages/world-model`'s derived
 * state and is only formatted here** (§5.4). A calculation in this file would be a derived rule in
 * the wrong package: invisible to fusion's provenance and confidence, recomputed per turn inside a
 * 5 ms budget, and impossible for a tool result to agree with.
 *
 * Droppable, and reconstructible: `get_timings` and `get_build_benchmark` return the same numbers on
 * demand, which is what makes it safe for the budget to eat this before `map`.
 */

import type { ItemId } from '../../common/types.js';
import type { SectionSource } from '../contracts.js';
import { clockText, duration, join, line, path, rendererFor, short } from './util.js';

/** `DerivedView`'s shape for "the next item, and when". */
interface NextItem {
  readonly item: ItemId;
  readonly inSeconds: number;
}

export const derived: SectionSource = {
  id: 'derived',

  build(world, ctx) {
    const field = rendererFor(world, ctx);

    return line(
      'derived',
      '',
      join([
        field('buy', world.get<NextItem>(path('derived.nextItem')), (v) => {
          const next = v as NextItem;
          return `${String(next.item)} in ~${duration(next.inSeconds)}`;
        }),
        field('rosh window', world.get<number>(path('derived.roshanWindowAt')), (v) =>
          clockText(Number(v)),
        ),
        field('rune', world.get<number>(path('derived.nextRuneAt')), (v) => clockText(Number(v))),
        field('nw lead', world.get<number>(path('derived.netWorthLead')), (v) => {
          const lead = Number(v);
          return `${lead >= 0 ? 'us +' : 'them +'}${short(Math.abs(lead))}`;
        }),
      ]),
    );
  },
};

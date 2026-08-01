/**
 * `economy: gold 1840 (rel 320) | nw 7.2k | next diffusal2 in ~40s | buyback 1650`
 *
 * The lead section for both economy triggers, and they pull in opposite directions:
 * `can_afford_key_item` is about what the gold *is for*, `buyback_unaffordable` is about what it is
 * *not enough for*. Both need the same four numbers, which is why one section serves both.
 *
 * `next` is `DerivedView`'s, and the "in ~40s" is its estimate rather than a subtraction here —
 * dota2 §6.2's "far better than making the model do gold math it will sometimes get wrong" applies
 * to us as much as to the model.
 */

import type { ItemId } from '../../common/types.js';
import type { BriefSectionSource } from '../contracts.js';
import { duration, fieldsFor, join, line, path, short } from './util.js';

/** `DerivedView`'s shape for "the next item, and when". Identical to the snapshot's, deliberately. */
interface NextItem {
  readonly item: ItemId;
  readonly inSeconds: number;
}

export const economy: BriefSectionSource = {
  id: 'economy',

  build(world, ctx) {
    const field = fieldsFor(ctx, world.clock);
    const reliable = field('', world.get<number>(path('self.goldReliable')));

    return line(
      'economy',
      'economy',
      join([
        field('gold', world.get<number>(path('self.gold')), (v) =>
          reliable === null ? String(v) : `${String(v)} (rel ${reliable})`,
        ),
        field('nw', world.get<number>(path('self.netWorth')), (v) => short(Number(v))),
        field('next', world.get<NextItem>(path('derived.nextItem')), (v) => {
          const next = v as NextItem;
          return `${String(next.item)} in ~${duration(next.inSeconds)}`;
        }),
        field('buyback', world.get<number>(path('derived.buybackCost')), (v) => short(Number(v))),
      ]),
    );
  },
};

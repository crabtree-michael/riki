/**
 * `items: diffusal(1), phase, wraith, tp | stash: -- | slots 3 free`
 *
 * Never droppable. What is already bought is what makes "you can afford X" advice either useful or
 * embarrassing, and the stash line is the cheapest correct nag in the game.
 */

import type { SectionSource } from '../contracts.js';
import { join, line, path, rendererFor } from './util.js';

/** One inventory slot. `charges` is absent for items that have none. */
interface ItemState {
  readonly id: string;
  readonly charges?: number;
}

function items(list: readonly ItemState[]): string {
  return list.length === 0
    ? '--'
    : list
        .map((i) => (i.charges === undefined ? i.id : `${i.id}(${String(i.charges)})`))
        .join(', ');
}

export const selfItems: SectionSource = {
  id: 'self_items',

  build(world, ctx) {
    const field = rendererFor(world, ctx);

    return line(
      'self_items',
      'items',
      join([
        field('', world.get<readonly ItemState[]>(path('self.items')), (v) =>
          items(v as readonly ItemState[]),
        ),
        field('stash', world.get<readonly ItemState[]>(path('self.stash')), (v) =>
          items(v as readonly ItemState[]),
        ),
        field('slots', world.get<number>(path('self.freeSlots')), (v) => `${String(v)} free`),
      ]),
    );
  },
};

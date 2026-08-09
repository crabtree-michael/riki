/**
 * `items: diffusal(1), phase, wraith | stash -- | tp tpscroll(1) | neutral trusty_shovel | slots 3 free`
 *
 * Never droppable. What is already bought is what makes "you can afford X" advice either useful or
 * embarrassing, and the stash line is the cheapest correct nag in the game.
 *
 * **`tp` and `neutral` are separate fields, not entries in the item list**, and that is the whole
 * reason they are here: they live in their own GSI slots, `self.items` projects only the inventory,
 * and folding them into the list would say the player is carrying a TP in a bag slot. Both render
 * `--` when empty rather than being omitted, because an empty TP slot is the single most actionable
 * thing on this line and an omitted field is indistinguishable from an unobserved one.
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
        field('tp', world.get<readonly ItemState[]>(path('self.teleport')), (v) =>
          items(v as readonly ItemState[]),
        ),
        field('neutral', world.get<readonly ItemState[]>(path('self.neutral')), (v) =>
          items(v as readonly ItemState[]),
        ),
        field('slots', world.get<number>(path('self.freeSlots')), (v) => `${String(v)} free`),
      ]),
    );
  },
};

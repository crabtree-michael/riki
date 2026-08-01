/**
 * `get_item_info` — cost and components for one item.
 *
 * The `reference`-class archetype: patch-keyed data that is not about this match, behind a port
 * with a short deadline. A miss is a plain `unavailable` because reference data is by definition
 * not urgent — dota2 §2.4 already treats it as best-effort (§5.3).
 */

import type { ItemId } from '../types.js';
import type { ItemInfo } from '../ports.js';
import { compose } from '../render.js';
import { defineArgs } from '../codec.js';
import { defineTool } from '../registry.js';

const args = defineArgs({
  item: {
    kind: 'item',
    description: 'The item, however the player says it — "bkb", "black king bar".',
  },
});

export const getItemInfo = defineTool({
  name: 'get_item_info',
  effect: 'reference',
  summary: 'What an item costs and what it builds from, for the current patch.',
  args,
  needs: ['reference'],

  handler: async (a, ctx) => ctx.ports.reference.item(a.item as ItemId),

  renderer: {
    render(value: ItemInfo, ctx) {
      const components = value.components.map(String).join(' + ');
      return compose(
        [
          { id: 'item', priority: 100, droppable: false, text: String(value.id) },
          { id: 'cost', priority: 90, text: `${String(value.cost)}g` },
          { id: 'components', priority: 40, text: components === '' ? null : `from ${components}` },
        ],
        ctx,
      );
    },
  },
});

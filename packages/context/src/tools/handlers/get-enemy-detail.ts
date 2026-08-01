/**
 * `get_enemy_detail` — everything observed about one enemy.
 *
 * The `model`-class archetype: a memory read wearing a promise. It touches one port, returns a
 * structure of `Observed` fields, and decides nothing about how any of it reads.
 *
 * See docs/design/agent-command-execution-architecture.md §4.5, dota2 §6.3.
 */

import type { FieldPath } from '../../common/ports.js';
import type { EnemyDetail } from '../contracts.js';
import type { HeroId, ItemId } from '../types.js';
import { compose, duration, field } from '../render.js';
import { defineArgs } from '../codec.js';
import { defineTool } from '../registry.js';
import { ok } from '../failures.js';

const args = defineArgs({
  hero: {
    kind: 'hero',
    description: 'The enemy hero, however the player says it — "sf", "shadow fiend", "nevermore".',
  },
});

export const getEnemyDetail = defineTool({
  name: 'get_enemy_detail',
  effect: 'model',
  summary:
    'What is known about one enemy hero right now: level, alive or dead, where they were last ' +
    'seen, and which items have been spotted. Ages and confidence are included.',
  args,
  needs: ['world'],
  limits: { maxResultTokens: 120 },

  handler: (a, ctx) => {
    const snapshot = ctx.ports.world.snapshot(ctx.now);
    const hero = a.hero as HeroId;
    const at = (leaf: string): FieldPath => `enemies.${String(hero)}.${leaf}` as FieldPath;

    // Absent throughout means *never observed*, which the renderer drops silently. That is the
    // point: an enemy nobody has seen an item on produces no items line, not an empty one.
    const level = snapshot.get<number>(at('level'));
    const alive = snapshot.get<boolean>(at('alive'));
    const respawnIn = snapshot.get<number>(at('respawnIn'));
    const lastSeen = snapshot.get<string>(at('area'));
    const items = snapshot.get<readonly ItemId[]>(at('itemsSeen'));

    const detail: EnemyDetail = {
      hero,
      ...(level === undefined ? {} : { level }),
      ...(alive === undefined ? {} : { alive }),
      ...(respawnIn === undefined ? {} : { respawnIn }),
      ...(lastSeen === undefined ? {} : { lastSeen }),
      // Each item keeps the confidence of the sighting that produced the list, so a low-confidence
      // scoreboard read cannot contribute an item the renderer then states flatly.
      itemsSeen: items === undefined ? [] : items.value.map((item) => ({ ...items, value: item })),
    };

    return Promise.resolve(ok(detail));
  },

  renderer: {
    render(value: EnemyDetail, ctx) {
      const items = value.itemsSeen
        .map((item) => field('', item, ctx, String))
        .filter((text): text is string => text !== null)
        .join(', ');

      return compose(
        [
          // Priority ladder: who, and whether they are alive, survives a tight budget. The item
          // list goes first — it is the longest and the least time-critical.
          { id: 'hero', priority: 100, droppable: false, text: String(value.hero) },
          {
            id: 'alive',
            priority: 90,
            // Through `field()` like everything else, so "dead" cannot be spoken as a certainty on
            // the strength of a 30-second-old detection.
            text: field('', value.alive, ctx, (v) => (v === true ? 'alive' : 'dead')),
          },
          {
            id: 'respawn',
            priority: 85,
            text: field('respawn', value.respawnIn, ctx, (v) => duration(Number(v))),
          },
          { id: 'level', priority: 80, text: field('lvl', value.level, ctx) },
          { id: 'lastSeen', priority: 70, text: field('at', value.lastSeen, ctx) },
          { id: 'items', priority: 10, text: items === '' ? null : `items ${items}` },
        ],
        ctx,
      );
    },
  },
});

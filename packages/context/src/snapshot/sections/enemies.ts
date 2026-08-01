/**
 * `enemies: cm lvl10 alive · sf lvl12 alive · tide lvl11 DEAD 22s`
 *
 * Never droppable (dota2 §6.2). This is the *roster* line — who exists, what level they are, and
 * who is dead right now. It is deliberately not the same thing as `seen:`, which is the line about
 * where they are: this one is close to certain and that one is a hypothesis, and merging them would
 * be the fastest way to make a hypothesis look like a roster fact.
 */

import type { HeroId } from '../../common/types.js';
import type { SectionSource } from '../contracts.js';
import { duration, join, line, path, rendererFor } from './util.js';

export const enemies: SectionSource = {
  id: 'enemies',

  build(world, ctx) {
    const field = rendererFor(world, ctx);
    const roster = world.roster().enemies;

    const each = roster.map((hero: HeroId) => {
      const at = (leaf: string): string => `enemies.${String(hero)}.${leaf}`;
      const alive = world.get<boolean>(path(at('alive')));
      const respawn = world.get<number>(path(at('respawnIn')));

      return join(
        [
          String(hero),
          field('lvl', world.get<number>(path(at('level')))),
          field('', alive, (v) => (v === true ? 'alive' : 'DEAD')),
          // Only meaningful next to a `DEAD`, and it renders only when the model actually holds it.
          alive?.value === false ? field('', respawn, (v) => duration(Number(v))) : null,
        ],
        ' ',
      );
    });

    return line('enemies', 'enemies', join(each, ' · '));
  },
};

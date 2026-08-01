/**
 * `T 14:32 | day | you: riki lvl 11, 84% hp, 61% mp, alive, top jungle`
 *
 * Never droppable, and it is the one section that renders even when the world model holds nothing:
 * the model cannot hedge without knowing when "now" is, and a snapshot with no clock in it is a
 * snapshot whose every other line is undated. Pre-horn it says `T pre-horn`, which is a fact
 * (§10, "never an empty string").
 */

import type { HeroId } from '../../common/types.js';
import type { SectionSource } from '../contracts.js';
import { clockText, join, line, path, rendererFor } from './util.js';

export const header: SectionSource = {
  id: 'header',

  build(world, ctx) {
    const field = rendererFor(world, ctx);
    const hero = world.get<HeroId>(path('self.hero'));
    const daytime = world.get<boolean>(path('map.daytime'));

    const you = join(
      [
        hero === undefined ? null : `you: ${String(hero.value)}`,
        field('lvl', world.get<number>(path('self.level'))),
        field('', world.get<number>(path('self.hpPct')), (v) => `${String(v)}% hp`),
        field('', world.get<number>(path('self.mpPct')), (v) => `${String(v)}% mp`),
        field('', world.get<boolean>(path('self.alive')), (v) => (v === true ? 'alive' : 'DEAD')),
        field('', world.get<string>(path('self.area'))),
      ],
      ', ',
    );

    return line(
      'header',
      '',
      join([
        `T ${clockText(world.clock)}`,
        field('', daytime, (v) => (v === true ? 'day' : 'night')),
        you,
      ]),
    );
  },
};

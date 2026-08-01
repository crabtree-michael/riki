/**
 * `gold 1840 (rel 320) | nw 7.2k | 4/1/3 | lh 96/12 | gpm 512`
 *
 * Never droppable (dota2 §6.2). Every number here is GSI's, exact and sub-second, and it is the
 * substrate of most correct advice: what the player can buy, whether they are ahead, whether the
 * lane is going the way they think it is.
 */

import type { SectionSource } from '../contracts.js';
import { join, line, path, rendererFor, short } from './util.js';

interface Kda {
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
}

export const selfEconomy: SectionSource = {
  id: 'self_economy',

  build(world, ctx) {
    const field = rendererFor(world, ctx);

    // Every companion number goes back through `field()` rather than being read off `.value`:
    // a secondary field is exactly where a stale fact gets stated flatly, because nobody is
    // looking at it.
    const reliable = field('', world.get<number>(path('self.goldReliable')));
    const denies = field('', world.get<number>(path('self.denies')));

    return line(
      'self_economy',
      '',
      join([
        field('gold', world.get<number>(path('self.gold')), (v) =>
          reliable === null ? String(v) : `${String(v)} (rel ${reliable})`,
        ),
        field('nw', world.get<number>(path('self.netWorth')), (v) => short(Number(v))),
        field('', world.get<Kda>(path('self.kda')), (v) => {
          const kda = v as Kda;
          return `${String(kda.kills)}/${String(kda.deaths)}/${String(kda.assists)}`;
        }),
        field('lh', world.get<number>(path('self.lastHits')), (v) =>
          denies === null ? String(v) : `${String(v)}/${denies}`,
        ),
        field('gpm', world.get<number>(path('self.gpm'))),
      ]),
    );
  },
};

/**
 * `pace: nw +1.2k vs typical | lvl -1 vs typical | lh 96 | gpm 512`
 *
 * Where the player actually is against where a typical game on this hero would be. The lead section
 * for a `system` turn, and the second line of every economy trigger — "you can afford a BKB" is a
 * reminder; "you can afford a BKB and you are a level behind" is coaching.
 *
 * **Both comparisons are `DerivedView`'s numbers, formatted.** The benchmark itself is external,
 * patch-keyed data fetched at draft into the preamble (§5.3), so the comparison is a fact about the
 * match *and* a benchmark — which state-capture §7.3 puts in the world model rather than here.
 * [ADR-0019](../../../../../docs/adr/0019-get-build-benchmark-is-reference-class.md) is superseded
 * as a command classification and survives as exactly this constraint: benchmark data cannot answer
 * inside the per-turn budget, so it must already be in the model by the time a brief renders.
 */

import type { BriefSectionSource } from '../contracts.js';
import { fieldsFor, join, line, path, signed } from './util.js';

export const pace: BriefSectionSource = {
  id: 'pace',

  build(world, ctx) {
    const field = fieldsFor(ctx, world.clock);

    return line(
      'pace',
      'pace',
      join([
        field(
          'nw',
          world.get<number>(path('derived.paceNetWorth')),
          (v) => `${signed(Number(v))} vs typical`,
        ),
        field(
          'lvl',
          world.get<number>(path('derived.paceLevel')),
          (v) => `${signed(Number(v))} vs typical`,
        ),
        field('lh', world.get<number>(path('self.lastHits'))),
        field('gpm', world.get<number>(path('self.gpm'))),
      ]),
    );
  },
};

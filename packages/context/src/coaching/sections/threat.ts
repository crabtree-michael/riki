/**
 * `threat: hp 22% | mp 40% | sf bot ~3s · cm mid ~7s`
 *
 * Who can reach the player, and how much room the player has. The lead section for
 * `low_hp_no_escape`, which is the shortest-lived and highest-salience thing Riki says.
 *
 * **Reachability is `DerivedView`'s, not this file's.** "Can that hero get to me" is a function of
 * two positions, a movement speed and a set of blinks — arithmetic over several observed values,
 * with its own confidence, which state-capture §6 puts in `packages/world-model` and memoises per
 * version. Computing it here would put game maths inside the 5 ms budget and produce a number with
 * no provenance sitting next to numbers that have some.
 */

import type { BriefSectionSource } from '../contracts.js';
import { duration, fieldsFor, join, line, path } from './util.js';

/** `DerivedView`'s shape for one reachable enemy. `etaSeconds` is its number, not ours. */
interface Threat {
  readonly hero: string;
  readonly area: string;
  readonly etaSeconds: number;
}

export const threat: BriefSectionSource = {
  id: 'threat',

  build(world, ctx) {
    const field = fieldsFor(ctx, world.clock);

    return line(
      'threat',
      'threat',
      join([
        field('hp', world.get<number>(path('self.hpPct')), (v) => `${String(v)}%`),
        field('mp', world.get<number>(path('self.mpPct')), (v) => `${String(v)}%`),
        // One `field()` for the whole list: they come from one derived computation over one
        // version, so they share an age and a confidence. Rendering them separately would imply
        // the list was assembled from several observations.
        field('', world.get<readonly Threat[]>(path('derived.threats')), (v) =>
          (v as readonly Threat[])
            .map((t) => `${t.hero} ${t.area} ~${duration(t.etaSeconds)}`)
            .join(' · '),
        ),
      ]),
    );
  },
};

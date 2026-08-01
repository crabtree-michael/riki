/**
 * `map: t1 mid(them) · t1 top(us) down · rax bot(us)`
 *
 * Towers and barracks. Slow-moving, so the model can ask for it (`get_timings`, and the minimap
 * summary) rather than being told every turn — which is why it sits second-from-bottom on the
 * ladder despite being genuinely useful.
 */

import type { SectionSource } from '../contracts.js';
import { join, line, path, rendererFor } from './util.js';

/** `packages/world-model`'s building state, already reduced: one entry per interesting building. */
interface BuildingState {
  readonly id: string;
  readonly side: 'us' | 'them';
  readonly down: boolean;
}

function buildings(list: readonly BuildingState[]): string {
  return list.map((b) => `${b.id}(${b.side})${b.down ? ' down' : ''}`).join(' · ');
}

export const map: SectionSource = {
  id: 'map',

  build(world, ctx) {
    const field = rendererFor(world, ctx);

    return line(
      'map',
      'map',
      join([
        field('', world.get<readonly BuildingState[]>(path('map.towers')), (v) =>
          buildings(v as readonly BuildingState[]),
        ),
        field('', world.get<readonly BuildingState[]>(path('map.barracks')), (v) =>
          buildings(v as readonly BuildingState[]),
        ),
      ]),
    );
  },
};

/**
 * `abils: blink_strike UP, tricks_of_trade 4s, smoke_screen UP, invis UP`
 *
 * Never droppable, because cooldowns are the highest-frequency correct advice there is: almost
 * everything a coach says in a fight is a function of what is off cooldown on both sides, and it is
 * the one thing GSI reports exactly and continuously for the local player.
 */

import type { SectionSource } from '../contracts.js';
import { duration, line, path, rendererFor } from './util.js';

/** `packages/world-model`'s shape for one ability slot. Cooldown in seconds; 0 means ready. */
interface AbilityState {
  readonly id: string;
  readonly cooldown: number;
}

export const selfAbilities: SectionSource = {
  id: 'self_abilities',

  build(world, ctx) {
    const field = rendererFor(world, ctx);
    const abilities = world.get<readonly AbilityState[]>(path('self.abilities'));

    // One `field()` call for the whole list rather than one per ability: they come from a single
    // GSI read, so they share one age and one confidence, and rendering the ages separately would
    // imply the list was assembled from several observations.
    return line(
      'self_abilities',
      'abils',
      field('', abilities, (v) =>
        (v as readonly AbilityState[])
          .map((a) => `${a.id} ${a.cooldown <= 0 ? 'UP' : duration(a.cooldown)}`)
          .join(', '),
      ),
    );
  },
};

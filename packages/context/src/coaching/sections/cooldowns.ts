/**
 * `cooldowns: you blink_strike UP, invis 4s | them sf UP · tide 41s`
 *
 * Both sides of the fight, and they are not the same kind of fact — which is why they are two
 * halves of one line rather than one list.
 *
 * The player's abilities come from GSI: exact, continuous, and the highest-frequency correct advice
 * there is, because almost everything a coach says in a fight is a function of what is off cooldown.
 * The enemy ultimates come from the console log and from CV, so they are **inferred**, they carry an
 * age, and they are the half that goes first when the budget is tight. Rendering them as one
 * undifferentiated list would let a 40-second-old inference read like a GSI read.
 */

import type { HeroId } from '../../common/types.js';
import type { BriefSectionSource } from '../contracts.js';
import { duration, fieldsFor, join, line, path } from './util.js';

/** `packages/world-model`'s shape for one ability slot. Cooldown in seconds; 0 means ready. */
interface AbilityState {
  readonly id: string;
  readonly cooldown: number;
}

function ready(cooldown: number): string {
  return cooldown <= 0 ? 'UP' : duration(cooldown);
}

export const cooldowns: BriefSectionSource = {
  id: 'cooldowns',

  build(world, ctx) {
    const field = fieldsFor(ctx, world.clock);

    // One `field()` for the whole list rather than one per ability: they come from a single GSI
    // read, so they share one age and one confidence.
    const mine = field('you', world.get<readonly AbilityState[]>(path('self.abilities')), (v) =>
      (v as readonly AbilityState[]).map((a) => `${a.id} ${ready(a.cooldown)}`).join(', '),
    );

    // Theirs is per hero, because each ultimate was observed separately and at a different moment.
    const theirs = join(
      world
        .roster()
        .enemies.map((hero: HeroId) =>
          field(
            String(hero),
            world.get<AbilityState>(path(`enemies.${String(hero)}.ultimate`)),
            (v) => ready((v as AbilityState).cooldown),
          ),
        ),
      ' · ',
    );

    return line('cooldowns', 'cooldowns', join([mine, theirs === null ? null : `them ${theirs}`]));
  },
};

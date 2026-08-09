/**
 * `abils: blink_strike L2 UP, tricks_of_trade L1 4s, smoke_screen L3 UP, invis L0`
 *
 * Never droppable, because cooldowns are the highest-frequency correct advice there is: almost
 * everything a coach says in a fight is a function of what is off cooldown on both sides, and it is
 * the one thing GSI reports exactly and continuously for the local player.
 *
 * **The level is the skill build, and it is why this line is not just cooldowns.** GSI sends `level`
 * per slot on every POST, and without it the model is shown four ability names with no way to tell a
 * maxed nuke from one that was never taken — so it cannot answer "what should I skill next", which
 * is one of the questions players actually ask. An unskilled ability is rendered `L0` and nothing
 * else: Valve reports `can_cast: true` for slots at level 0, so appending the cooldown there would
 * print `invis L0 UP` about an ability the player does not have.
 */

import type { SectionSource } from '../contracts.js';
import { duration, line, path, rendererFor } from './util.js';

/**
 * `packages/world-model`'s shape for one ability slot. Cooldown in seconds; 0 means ready.
 *
 * `level` is optional here and not in the model, because this interface is a structural mirror of a
 * package `packages/context` may not import — a fact that never carried a level (a hand-built
 * fixture, an older recording) renders without one rather than printing `Lundefined`.
 */
interface AbilityState {
  readonly id: string;
  readonly cooldown: number;
  readonly level?: number;
}

/** `blink_strike L2 UP` · `tricks_of_trade L1 4s` · `invis L0` · `blink_strike UP` (no level known). */
function ability(a: AbilityState): string {
  const level = a.level === undefined ? '' : ` L${String(a.level)}`;
  if (a.level === 0) return `${a.id}${level}`;
  return `${a.id}${level} ${a.cooldown <= 0 ? 'UP' : duration(a.cooldown)}`;
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
      field('', abilities, (v) => (v as readonly AbilityState[]).map(ability).join(', ')),
    );
  },
};

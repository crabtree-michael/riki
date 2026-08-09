/**
 * `my_state()` — the player's own hero, right now.
 *
 * All GSI, so in a live match almost none of this is ever unknown. That is exactly why every field
 * still goes through `envelope`: the one time GSI is down is the one time the difference matters,
 * and a projection that is only honest when the data is good is not a projection. `MyStateReport`'s
 * own comment in `packages/protocol` makes the same argument about the shape.
 */

import type { ToolResultFor } from '@riki/protocol';
import type { AbilityState, ItemState } from '../state.js';
import type { ToolContext } from './context.js';
import {
  UNKNOWN_REASONS,
  atLeastZero,
  envelope,
  envelopeOf,
  noMatchInProgress,
  whole,
} from './context.js';
import { createBuybackAffordableRule } from '../derived/rules/economy.js';

/** GSI reports the whole loadout in one POST, so an absent field means GSI has said nothing. */
const NOT_SEEN = UNKNOWN_REASONS.neverObserved;

export function myState(ctx: ToolContext): ToolResultFor<'my_state'> {
  const noMatch = noMatchInProgress(ctx);
  if (noMatch !== null) return noMatch;

  const { state, now } = ctx;
  const self = state.self;

  return {
    hero: envelope(self.hero, now, NOT_SEEN),
    team: envelope(state.meta.team, now, NOT_SEEN),
    level: envelopeOf(self.level, now, NOT_SEEN, whole),
    alive: envelope(self.alive, now, NOT_SEEN),
    // Not in the design's table, and here because without it a dead hero reports `health: 0` and
    // the model says "you're at zero HP" — true, useless, and the wrong sentence. It is unknown
    // rather than zero while alive: GSI stops sending it, and "respawning in 0 seconds" is a
    // sentence about a hero who is about to be up, not one who never died.
    respawn_in_seconds: envelopeOf(self.respawnIn, now, NOT_SEEN, atLeastZero),
    health: envelope(self.health, now, NOT_SEEN),
    mana: envelope(self.mana, now, NOT_SEEN),
    gold: envelope(self.gold, now, NOT_SEEN),
    buyback: buyback(ctx),
    items: envelopeOf(self.items, now, NOT_SEEN, (items) => items.map(itemReport)),
    abilities: envelopeOf(self.abilities, now, NOT_SEEN, (list) => list.map(abilityReport)),
  };
}

/**
 * One fact over cost, cooldown and affordability together, because the schema bundles them and
 * because affordability is the field anyone asks for.
 *
 * `createBuybackAffordableRule` answers null unless *both* gold and the buyback cost were observed,
 * and this passes that refusal straight through rather than reporting the cost alone. Cost without
 * affordability invites the model to do the subtraction itself against a gold figure it fetched at
 * a different moment — which is the arithmetic dota2 §6.2 moved in here to stop it getting wrong.
 *
 * The rule stamps the result `derived` with the *minimum* confidence and the *oldest* `observedAt`
 * of the two inputs, so "you can buy back" carries the age of the staler reading rather than of the
 * computation.
 */
function buyback(ctx: ToolContext) {
  const fact = createBuybackAffordableRule().compute(ctx.state, ctx.now, ctx.clock);
  return envelopeOf(
    fact ?? undefined,
    ctx.now,
    'gold or the buyback cost was never observed',
    (v) => ({
      cost: atLeastZero(v.cost),
      cooldown_seconds: atLeastZero(v.cooldownSeconds),
      affordable: v.affordable,
    }),
  );
}

/** `slot` is dropped: the model speaks about items, and no answer is improved by an inventory index. */
function itemReport(item: ItemState) {
  return {
    id: String(item.id),
    location: item.location,
    charges: item.charges === undefined ? null : whole(item.charges),
    cooldown_seconds: atLeastZero(item.cooldown),
    castable: item.castable,
  };
}

function abilityReport(ability: AbilityState) {
  return {
    id: String(ability.id),
    level: whole(ability.level),
    cooldown_seconds: atLeastZero(ability.cooldown),
    castable: ability.castable,
    ultimate: ability.isUltimate,
  };
}

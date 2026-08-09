/**
 * `economy()` — net worth on both sides, the player's own rates, and lane equity where anything has
 * seen it.
 *
 * The interesting field is `team_net_worth`, and it is interesting because of when it refuses.
 */

import type { ToolResultFor } from '@riki/protocol';
import type { ToolContext } from './context.js';
import {
  UNKNOWN_REASONS,
  atLeastZero,
  envelope,
  envelopeOf,
  noMatchInProgress,
  whole,
} from './context.js';
import { createNetWorthLeadRule } from '../derived/rules/economy.js';

const NOT_SEEN = UNKNOWN_REASONS.neverObserved;

/**
 * Live GSI knows the player and nothing else, so a lane breakdown needs the scoreboard — and
 * nothing in this repo reads one yet. This is the honest form of that gap, and it is cheaper than
 * the alternative: a field the model has to infer is missing from its absence.
 */
const NO_SCOREBOARD = `lane net worth needs the scoreboard, and ${UNKNOWN_REASONS.sourceUnavailable}`;

export function economy(ctx: ToolContext): ToolResultFor<'economy'> {
  const noMatch = noMatchInProgress(ctx);
  if (noMatch !== null) return noMatch;

  const { state, now } = ctx;
  const self = state.self;

  return {
    my_net_worth: envelopeOf(self.netWorth, now, NOT_SEEN, atLeastZero),
    team_net_worth: teamNetWorth(ctx),
    gpm: envelope(self.gpm, now, NOT_SEEN),
    xpm: envelope(self.xpm, now, NOT_SEEN),
    last_hits: envelopeOf(self.lastHits, now, NOT_SEEN, whole),
    denies: envelopeOf(self.denies, now, NOT_SEEN, whole),
    lanes: { unknown: NO_SCOREBOARD },
  };
}

/**
 * All ten net worths or none.
 *
 * `createNetWorthLeadRule` answers null unless every hero on both sides has one, which in practice
 * means the scoreboard has been open. Passing that refusal through is the point: a lead computed
 * from six known values and four missing ones is not a smaller lead, it is a wrong one, and wrong
 * in whichever direction the missing heroes happened to fall. One fact over the pair, rather than
 * two facts that could each be half-known, is the schema's way of making that unrepresentable.
 */
function teamNetWorth(ctx: ToolContext) {
  const fact = createNetWorthLeadRule().compute(ctx.state, ctx.now, ctx.clock);
  return envelopeOf(
    fact ?? undefined,
    ctx.now,
    'not every hero on both sides has a net worth yet — the scoreboard has not been seen',
    (v) => ({ ours: atLeastZero(v.ours), theirs: atLeastZero(v.theirs), lead: v.lead }),
  );
}

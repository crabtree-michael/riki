/**
 * `get_matchup_advice` — how this hero fares into that one.
 *
 * Takes the player's own hero from the model rather than from an argument. The model already knows
 * which hero the player is on, and an argument the agent has to fill in is an argument the agent can
 * get wrong — `get_matchup_advice("pudge", "sf")` with the sides swapped is advice that reads
 * plausibly and is exactly backwards.
 */

import type { FieldPath } from '../../common/ports.js';
import type { HeroId } from '../types.js';
import type { MatchupNote } from '../ports.js';
import { compose } from '../render.js';
import { defineArgs } from '../codec.js';
import { defineTool } from '../registry.js';
import { failure, fromFetched } from '../failures.js';

const args = defineArgs({
  enemy: { kind: 'hero', description: 'The enemy hero to compare against.' },
});

export const getMatchupAdvice = defineTool({
  name: 'get_matchup_advice',
  effect: 'reference',
  summary: "How the player's hero fares against one enemy hero on the current patch.",
  args,
  needs: ['world', 'reference'],

  handler: async (a, ctx) => {
    const snapshot = ctx.ports.world.snapshot(ctx.now);
    const self = snapshot.get<HeroId>('self.hero' as FieldPath);
    if (self === undefined) {
      // Never observed, rather than a port failure: before the draft resolves there is no matchup
      // to describe, and saying so beats asking an external API about `undefined`.
      return failure('unavailable', { detail: 'self.hero not observed yet' });
    }
    return fromFetched(await ctx.ports.reference.matchup(self.value, a.enemy as HeroId));
  },

  renderer: {
    render(value: MatchupNote, ctx) {
      return compose(
        [
          { id: 'summary', priority: 100, droppable: false, text: value.summary },
          { id: 'patch', priority: 10, text: `patch ${value.patch}` },
        ],
        ctx,
      );
    },
  },
});

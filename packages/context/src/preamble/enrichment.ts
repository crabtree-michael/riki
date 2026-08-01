/**
 * What to fetch for this draft, in priority order — §4.3.
 *
 * The order is the whole content of this file, because the deadline eats the tail: **the player's
 * own hero benchmark is worth more than the fifth enemy's matchup note**, so it goes first and the
 * fifth matchup is what a slow OpenDota costs us.
 *
 * The alternative — block match start until enrichment lands — is worse than it looks. The draft is
 * roughly 90 seconds and the loading screen another 60; a slow or down external API would make Riki
 * silent through the laning phase, which is the phase where advice is most valuable and most
 * time-critical. A coach with no matchup notes is still a coach.
 */

import type { GameClock } from '../common/types.js';
import type { EnrichmentPlanner } from './contracts.js';
import type { DraftView, EnrichmentRequest, PlayerIdentity } from './types.js';

/**
 * The clock a benchmark is asked for *(tunable: 10 minutes)*.
 *
 * The end of the laning phase is where a net-worth comparison first says something actionable, and
 * it is early enough that the answer is still useful when it arrives.
 */
export const BENCHMARK_AT: GameClock = 600 as GameClock;

export function createEnrichmentPlanner(): EnrichmentPlanner {
  return {
    plan(draft: DraftView, player: PlayerIdentity): readonly EnrichmentRequest[] {
      const hero = player.hero;
      return [
        // 1. The player's own numbers. Useful in every match, including the ones where the draft
        //    turns out not to matter.
        { want: 'benchmark', hero, at: BENCHMARK_AT },
        // 2. Their lane matchups, enemy order as drafted — the world model's order, which is the
        //    same across a reconnect, so the preamble stays byte-identical (§4.4).
        ...draft.enemies.map((enemy): EnrichmentRequest => ({
          want: 'matchup',
          a: hero,
          b: enemy,
        })),
        // 3. Patch notes last: they change least often and are the least time-critical thing here.
        { want: 'patch_notes', hero },
      ];
    },
  };
}

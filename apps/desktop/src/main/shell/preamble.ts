/**
 * The Tier 1 preamble's input, assembled from the world model at `match_started`.
 *
 * `ContextAssembler.openSession` is documented as "called once per match, before the session
 * opens" and nothing had ever called it: the shell had no session to open. Now it does, and this
 * is the twenty lines between the world model and `PreambleInput`.
 *
 * ## What is real here and what is not
 *
 * **The draft is real.** GSI gives the ten heroes at `match_started` and they are the single most
 * valuable thing in the cached prefix — advice that names the enemy lineup is the difference
 * between a coach and a rules engine.
 *
 * **The role and the lane are not.** Neither is anywhere in `WorldState`: GSI does not report a
 * role, and lane assignment is an inference from early positions that `packages/world-model` does
 * not make. Both are `'unknown'`, which `packages/context` renders as an absent line rather than a
 * guess — and a guessed role is worse than none, because a support told it is a carry gets carry
 * advice for forty minutes.
 *
 * **The bracket is null, permanently by design.** dota2 §7 strips or hashes the Steam ID before any
 * egress, and a bracket is derivable from it; there is no source for one that does not start with
 * the identity we deliberately do not send.
 */

import type { MatchId, PlayerMemory, PreambleInput } from '@riki/context';
import type { HeroId, MonoMs, WorldModelReader } from '@riki/world-model';

/** Best-effort, and total: an empty draft still assembles a working preamble. */
export function buildPreambleInput(
  matchId: MatchId,
  world: WorldModelReader,
  memory: PlayerMemory,
  now: MonoMs,
): PreambleInput {
  const snapshot = world.snapshot(now);
  const state = snapshot.state;
  const self = state.self.hero?.value ?? ('unknown' as HeroId);

  return {
    matchId,
    draft: {
      self,
      allies: [...state.allies.keys()],
      enemies: [...state.enemies.keys()],
    },
    player: {
      hero: self,
      // See the header: neither is in the world model, and a guess is worse than an absence.
      role: 'unknown',
      lane: 'unknown',
      bracket: null,
    },
    patch: state.meta.patch?.value ?? 'unknown',
    memory,
  };
}

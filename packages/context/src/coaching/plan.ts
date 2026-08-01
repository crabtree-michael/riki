/**
 * `BRIEF_PLAN` — the seam between the two halves of coaching, as data.
 *
 * `packages/events` names an event kind. This table says what that kind is worth rendering and in
 * what order, and **it lives on this side of the edge on purpose** (coaching-architecture.md §4.4):
 * section priority interacts with the token budget, and the salience path must never acquire a
 * reason to know about tokens. Events names the moment; context decides what the moment needs.
 *
 * Two properties of the table, both load-bearing:
 *
 * - **It is exhaustive by type.** `BriefPlanKey` is a closed union, so a new event id with no row
 *   fails the compiler rather than producing a coaching turn with an empty brief — which §6.5 would
 *   turn into silence, i.e. a detector that fires and says nothing. `plan.test.ts` asserts the
 *   totality a second time, over values, for the case where an id arrives as a string from the wire.
 * - **Position is priority.** The first section of a row is what the turn is *about*, and it is the
 *   one section the budget may not eat — `render.ts` marks it undroppable. So a brief either
 *   carries the thing the trigger fired on or renders nothing at all, and there is no middle state
 *   where the model is handed context for advice it can no longer justify.
 *
 * `player_question` is the widest row, and that is §3.2's first mitigation rather than a default: a
 * player-initiated turn has no cause to focus on, so it gets everything the budget allows. It is
 * what recovers most of what `get_enemy_detail` and `get_minimap_summary` used to answer.
 */

import type { BriefPlanner } from './contracts.js';
import type { BriefPlanKey, BriefRequest, BriefSectionId } from './types.js';

/**
 * One row per event id, plus the two non-trigger causes.
 *
 * Adding an advice topic is one detector file in `packages/events`, one arm on `CoachEventId`, and
 * one row here. Two files, two packages, and no existing module changes behaviour — the one
 * genuinely good property the deleted tool registry had, carried over deliberately (§14).
 */
// `library` is never first, in any row. Position is priority and the first section is undroppable,
// so leading with it would let static hero notes survive a budget that dropped the observed fact
// the turn actually fired on — advice about a hero, in place of the reason for mentioning them.
// It sits above `history` and below everything observed, which is the order a coach would use:
// what is happening, then what that hero usually does, then what we already said about it.
export const BRIEF_PLAN: Readonly<Record<BriefPlanKey, readonly BriefSectionId[]>> = {
  // Reactive, shortest useful life. Where they were and what that means for the player, and
  // nothing about farm — a hero missing is not a moment to mention the benchmark.
  enemy_missing: ['positions', 'threat', 'library', 'history'],
  low_hp_no_escape: ['threat', 'positions', 'cooldowns', 'library', 'history'],

  // Economy moments. `pace` is what turns "you can afford a BKB" into "you can afford a BKB and
  // you are two minutes behind", which is the difference between a reminder and coaching.
  can_afford_key_item: ['economy', 'pace', 'history'],
  buyback_unaffordable: ['economy', 'threat', 'history'],

  // Predictive: these fire *before* the moment, which is the only time the advice is actionable.
  rune_soon: ['windows', 'positions', 'history'],
  stack_now: ['windows', 'economy', 'history'],

  // Cooldown windows, on both sides of the fight.
  ult_ready: ['cooldowns', 'threat', 'positions', 'history'],
  enemy_core_dead_window: ['cooldowns', 'threat', 'windows', 'library', 'history'],

  // §3.2 mitigation 1: no cause to focus on means the widest brief the budget allows.
  player_question: [
    'threat',
    'positions',
    'library',
    'economy',
    'cooldowns',
    'windows',
    'pace',
    'history',
  ],

  // A system turn — match start, or a rehydrate — is about the shape of the game, not a moment
  // in it.
  system: ['pace', 'library', 'economy', 'history'],
};

/** The row a request lands on. Unknown event ids fall to the widest plan rather than to nothing. */
export function planKeyFor(req: BriefRequest): BriefPlanKey {
  switch (req.cause.by) {
    case 'player':
      return 'player_question';
    case 'system':
      return 'system';
    case 'trigger': {
      const event = String(req.cause.event);
      // An id this table has not heard of is a `packages/events` that has shipped a detector ahead
      // of its row. Falling back to `player_question` is the safe direction: the turn is *going to
      // happen* — the gates already admitted it — so the choice is between a broad brief and no
      // brief, and no brief is a coaching turn with nothing behind it. `plan.test.ts` asserts the
      // table is total, so this path should be unreachable in a shipped build.
      return event in BRIEF_PLAN ? (event as BriefPlanKey) : 'player_question';
    }
  }
}

export function createBriefPlanner(
  table: Readonly<Record<BriefPlanKey, readonly BriefSectionId[]>> = BRIEF_PLAN,
): BriefPlanner {
  return {
    plan(req: BriefRequest): readonly BriefSectionId[] {
      return table[planKeyFor(req)];
    },
  };
}

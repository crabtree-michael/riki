/**
 * The coaching brief — what the model is shown for one specific piece of advice.
 *
 * The snapshot answers *what does the game look like*, in ~300 general tokens, every turn. The
 * brief answers *what does this particular thing I am about to say need*, in ~150 focused ones, and
 * it exists because the pull model that used to answer that question — the agent issuing a tool
 * call and waiting for a pipeline — was deleted (ADR-0023).
 *
 * Two properties are inherited from the design being replaced, and they were the two best things
 * about it:
 *
 * - **Total functions.** Nothing on this path throws or rejects. A section that cannot be rendered
 *   is omitted and recorded; a brief that renders nothing is a turn that does not happen
 *   (coaching-architecture.md §6.5), not an exception.
 * - **A stale fact renders with its age and confidence or it does not render.** The brief composes
 *   `../render/`'s `AgeFormatter`, so a bare value is not reachable. dota2 §4 rule 3, unchanged.
 *
 * See docs/design/coaching-architecture.md §4.3 and §5.4. Declarations only.
 */

import type { MonoMs, PrivacyPolicy, TurnId } from '../common/types.js';
import type { Budget, RenderedText, Section } from '../render/types.js';
import type { TurnCause } from '../snapshot/types.js';
import type { AdviceTopic } from '../memory/types.js';
import type { CoachingMemoryReader } from '../memory/contracts.js';

// -----------------------------------------------------------------------------------------------
// The section vocabulary (§4.4, §5.4)
// -----------------------------------------------------------------------------------------------

/**
 * The seam between the two halves of coaching, and it is **data owned by this package**.
 *
 * `packages/events` names an event kind; this package decides what that kind is worth rendering and
 * in what order. The edge stays one-directional and this type never crosses it — because section
 * priority interacts with the token budget, and the salience path must not acquire a reason to know
 * about tokens (§4.4).
 */
export type BriefSectionId =
  'threat' | 'economy' | 'windows' | 'cooldowns' | 'positions' | 'pace' | 'history';

/**
 * The event ids `packages/events` can emit, as this package needs to key on them.
 *
 * Eight, matching the in-flight `CoachEventKind` union rather than dota2 §6.4's nine.
 * `tower_diveable` is deliberately absent: it needs the enemy's health, which the world model does
 * not carry and which under the dota2 §8.2 fairness rule could only come from the player's own
 * screen. Shipping a plan row for a detector that can never fire would read as coverage.
 *
 * Written as literals rather than imported, which is what §4.4 buys: neither package has to wait
 * for the other to compile. A `BRIEF_PLAN` row for an id `packages/events` never emits is dead but
 * harmless; an id with no row is the failure `plan.test.ts` exists to catch.
 */
export type CoachEventId =
  | 'enemy_missing'
  | 'ult_ready'
  | 'can_afford_key_item'
  | 'low_hp_no_escape'
  | 'rune_soon'
  | 'enemy_core_dead_window'
  | 'stack_now'
  | 'buyback_unaffordable';

/**
 * One row per event id, plus the two non-trigger causes. Exhaustive by type.
 *
 * `player_question` is §3.2's first mitigation and the reason it is a plan key at all: a
 * player-initiated turn has no cause to focus on, so it gets the widest brief the budget allows,
 * which is what recovers most of what `get_enemy_detail` and `get_minimap_summary` used to answer.
 */
export type BriefPlanKey = CoachEventId | 'player_question' | 'system';

// -----------------------------------------------------------------------------------------------
// Requesting and rendering (§4.3)
// -----------------------------------------------------------------------------------------------

/** What the planner is given. */
export interface BriefRequest {
  readonly turnId: TurnId;
  readonly cause: TurnCause;
  /**
   * From the `CoachEvent`, for a trigger turn. Absent for a player or system turn.
   *
   * §6.6 row 4 is why this is a field here rather than a change to `TurnCause`: `CoachEvent` carries
   * a topic and `TurnCause` does not, and the alternative — deriving one from an `EventId` through a
   * second lookup table — is two tables that must agree about what "the same advice" means, which
   * is precisely what `AdviceTopic` being a closed union exists to prevent (ADR-0013). One value,
   * one origin, three consumers: the planner, the novelty gate, and `agent_said.topics`.
   */
  readonly topic?: AdviceTopic;
  readonly now: MonoMs;
  readonly budget: Budget;
  readonly privacy: PrivacyPolicy;
}

/** What the model is given for a coaching turn, alongside the snapshot. */
export interface CoachingBrief extends RenderedText {
  readonly turnId: TurnId;
  readonly sections: readonly Section[];
  /** Dropped by the budget or by the confidence gate. Telemetry, and asserted by golden tests. */
  readonly omitted: readonly BriefSectionId[];
  /**
   * Nothing survived, so there is nothing to say.
   *
   * §6.5: the correct behaviour is a recorded silent turn, not an opened session turn with an empty
   * brief in it and a model left to improvise. The failure is a value, which is the same rule the
   * deleted pipeline's total functions held.
   */
  readonly empty: boolean;
}

/**
 * What a section source is given, beyond the world snapshot.
 *
 * The request, plus the one thing a section may read that is not a game fact: what Riki has
 * already said. `history` is the only section that uses it, and it is the section with no
 * equivalent in the deleted design — the one that makes a second mention read as *"still worth
 * getting that BKB"* rather than as an alarm clock repeating itself (§5.4).
 */
export interface BriefContext extends BriefRequest {
  /** Null when the composition root wired no memory. `history` renders nothing rather than lying. */
  readonly history: CoachingMemoryReader | null;
}

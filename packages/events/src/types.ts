/**
 * This package's vocabulary: what a detector produces, what a score is, and every reason to refuse.
 *
 * The shape of this file is the design. Detection, salience and the gates are three separate types
 * because they are three separate questions — *what is true*, *how much does it matter*, and
 * *should we say it anyway* — and folding any two of them together produces a specific failure that
 * coaching-trigger-architecture.md §5.2 names. A `Detection` therefore carries no score, and a
 * `CoachEvent` carries no decision.
 *
 * Declarations only. See docs/design/coaching-trigger-architecture.md §2.
 */

import type { AdviceTopic, EventId } from '@riki/context';
import type { GameClock, MonoMs } from '@riki/world-model';

/** Every subscription in this package returns its own disposer. */
export type Unsubscribe = () => void;

// -----------------------------------------------------------------------------------------------
// What can be coached on
// -----------------------------------------------------------------------------------------------

/**
 * Eight, not dota2 §6.4's nine.
 *
 * `tower_diveable` is deliberately absent: it needs the enemy's health, which the world model does
 * not carry and which under the dota2 §8.2 fairness rule could only come from the player's own
 * screen. Shipping a detector that can never fire would read as coverage.
 *
 * `packages/context`'s `BRIEF_PLAN` has one row per member, keyed on these strings written as
 * literals rather than imported — which is what let the content half of coaching ship before this
 * package existed at all (coaching-architecture.md §4.4).
 */
export type CoachEventKind =
  | 'enemy_missing'
  | 'ult_ready'
  | 'can_afford_key_item'
  | 'low_hp_no_escape'
  | 'rune_soon'
  | 'enemy_core_dead_window'
  | 'stack_now'
  | 'buyback_unaffordable';

export const COACH_EVENT_KINDS: readonly CoachEventKind[] = [
  'enemy_missing',
  'ult_ready',
  'can_afford_key_item',
  'low_hp_no_escape',
  'rune_soon',
  'enemy_core_dead_window',
  'stack_now',
  'buyback_unaffordable',
];

/**
 * Identifies one *instance* of a condition, and it is the latch key.
 *
 * `enemy_missing:sf` rather than `enemy_missing`. The distinction is the only reason this type
 * exists: a cooldown asks "how long since I said this kind of thing", a latch asks "has this exact
 * condition been true without interruption since I mentioned it", and the second question needs an
 * identity for the condition rather than for the kind (§5.3).
 */
export type DetectionKey = string & { readonly __brand: 'DetectionKey' };

export function detectionKey(kind: CoachEventKind, instance?: string): DetectionKey {
  return (instance === undefined ? kind : `${kind}:${instance}`) as DetectionKey;
}

/**
 * The topic for a kind that is about *itself* rather than about a hero, an item or an objective.
 *
 * Four of the eight name a hero (`enemy_missing`, `enemy_core_dead_window`), an item
 * (`can_afford_key_item`) or an objective (`rune_soon`, `stack_now`), and those are the topics the
 * novelty gate can be most precise about. The rest are about a situation, and `{ of: 'event' }` is
 * the arm `AdviceTopic` provides for exactly that.
 *
 * One function so the brand is applied in one place: `EventId` and `CoachEventKind` are the same
 * string seen from two packages, and this is the seam where that is asserted rather than assumed.
 */
export function eventTopic(kind: CoachEventKind): AdviceTopic {
  return { of: 'event', event: kind as EventId };
}

// -----------------------------------------------------------------------------------------------
// Detection (§3)
// -----------------------------------------------------------------------------------------------

/**
 * What a detector produces: facts about the moment. No score, and no decision.
 *
 * `magnitude` and `actWithinSeconds` are here rather than in the scorer because only the detector
 * knows that a hero missing for 40 s beats one missing for 21 s, and only the detector knows how
 * long its own advice stays actionable. The scorer turns them into one comparable number (§4.1).
 */
export interface Detection {
  readonly kind: CoachEventKind;
  readonly key: DetectionKey;
  /**
   * The topic, imported rather than redefined.
   *
   * ADR-0013 makes `AdviceTopic` a closed union owned by `packages/context`; a second topic
   * vocabulary here would be two tables that must agree about what "the same advice" means. One
   * value, one origin, three consumers: the brief planner, the novelty gate, and `agent_said`.
   */
  readonly topic: AdviceTopic;
  /** 0..1. How big is *this* instance of this kind. */
  readonly magnitude: number;
  /** Seconds for which the advice stays actionable. `null` means there is no deadline. */
  readonly actWithinSeconds: number | null;
  /** The minimum confidence of the facts behind it — the same rule `derivedFact` uses (§4.3). */
  readonly confidence: number;
  /**
   * Already natural language, for the event tape (§6).
   *
   * The model never sees this on the trigger path: what it is shown for a coaching turn is the
   * brief, rendered from the world model by `packages/context`. This string exists so the
   * snapshot's `recent:` line can say what has been happening.
   */
  readonly text: string;
  readonly atGameClock: GameClock | null;
}

/** A detection that has been scored. Still not a decision. */
export interface CoachEvent {
  /**
   * The kind, as `packages/context`'s `EventId`. This is what `BRIEF_PLAN` and `TurnCause` key on.
   *
   * The same string as `kind`, and both are carried because they are different contracts: `kind` is
   * this package's closed union, and `id` is the value the other package matches on — so the
   * composition root copies a field rather than translating one (coaching-architecture.md §4.3).
   */
  readonly id: EventId;
  readonly kind: CoachEventKind;
  readonly key: DetectionKey;
  readonly topic: AdviceTopic;
  readonly salience: number;
  readonly detection: Detection;
  readonly at: MonoMs;
}

// -----------------------------------------------------------------------------------------------
// Refusal (§5)
// -----------------------------------------------------------------------------------------------

/**
 * Thirteen, exhaustive, and individually counted.
 *
 * The count is not the point; the individuality is. "Riki said nothing" must never be
 * indistinguishable from "Riki noticed nothing" (coaching-architecture.md §6.3), and the ratio of
 * triggers detected to turns spoken **broken down by which gate refused** is the primary tuning
 * signal under a proactive product. A single `suppressed` counter would answer none of the
 * questions §12 asks.
 */
export type SuppressionReason =
  /** No live match, or a mode where the advice would simply be wrong: Turbo, Ability Draft, custom. */
  | 'not_in_match'
  /** "Only when I ask". The off switch for the primary path, and it must work with the model down. */
  | 'quiet_mode'
  | 'muted'
  /** A turn is already open. A second trigger is dropped, never queued (§5.5). */
  | 'agent_speaking'
  | 'player_speaking'
  | 'high_intensity'
  /** The condition has been continuously true since Riki last mentioned it (§5.3). */
  | 'latched'
  | 'kind_cooldown'
  | 'global_cooldown'
  /** dota2 §6.4's novelty gate, first half: they acted on it. */
  | 'already_advised'
  /** …and second half: they ignored it twice. */
  | 'ignored_twice'
  /** Urgency is zero — the advice would arrive after its window closed (§4.2). */
  | 'stale_window'
  | 'below_threshold';

export const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  'not_in_match',
  'quiet_mode',
  'muted',
  'agent_speaking',
  'player_speaking',
  'high_intensity',
  'latched',
  'kind_cooldown',
  'global_cooldown',
  'already_advised',
  'ignored_twice',
  'stale_window',
  'below_threshold',
];

/**
 * The answer, as a value.
 *
 * Nothing on this path throws: a refusal is a `TriggerDecision` with a reason on it, which is what
 * makes the whole gate ladder a Tier 1 test over a table. `event` is null only when there was
 * nothing to refuse — the detectors produced no candidate at all.
 */
export type TriggerDecision =
  | { readonly speak: true; readonly event: CoachEvent }
  | {
      readonly speak: false;
      readonly reason: SuppressionReason;
      readonly event: CoachEvent | null;
    };

/** Per-reason refusals, plus per-kind detections. Both halves are needed; §5.4 says why. */
export interface TriggerCounters {
  readonly suppressed: Readonly<Record<SuppressionReason, number>>;
  /** A kind with zero detections in a whole match is unwired, not quiet (§3.3). */
  readonly detected: Readonly<Record<CoachEventKind, number>>;
  readonly spoken: number;
}

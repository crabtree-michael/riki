/**
 * One number, comparable across kinds, so that ranking and the threshold have something to work on.
 *
 * ```
 * salience = kindWeight × magnitude × urgency × confidence × tendency
 * ```
 *
 * Five factors, each owned by exactly one place, and the ownership is the design
 * (coaching-trigger-architecture.md §4.1). Two of them are worth restating here because they are
 * the ones an implementation tends to quietly drop:
 *
 * - **Confidence is a multiplier and must not be dropped.** coaching-architecture.md §6.2: *"A
 *   CV-derived detection at 0.55 confidence is worth less than the same detection from GSI … if
 *   salience drops it, the confidence gate becomes decoration at exactly the point it matters
 *   most."* It multiplies rather than gates because the right response to a half-confident
 *   detection is to *rank it below a certain one* — the brief will render it with its age and
 *   confidence attached, so a hedged statement is reachable and a false certainty is not.
 * - **Cooldowns are not in here.** Folding one in makes the threshold untunable, because the number
 *   would then mean both "not important" and "important but said recently", and no single threshold
 *   is right for both (coaching-architecture.md §4.4). A cooldown is a gate with its own counter.
 *
 * See docs/design/coaching-trigger-architecture.md §4.
 */

import type { SalienceScorer, TendencyIndex } from './contracts.js';
import type { TriggerConfig } from './config.js';
import type { Detection } from './types.js';

/**
 * Urgency, 0..1, from a deadline and the fact that speaking is not instant.
 *
 * Two properties, both load-bearing:
 *
 * - **Advice that would arrive after its window closed scores zero.** The deadline has
 *   `speakLatencySeconds` subtracted from it first, so "40 seconds until the rune" and "1 second
 *   until the rune" are not the same kind of late — the second one is wrong rather than urgent, and
 *   a zero here becomes a counted `stale_window` refusal rather than a very high score.
 * - **Nearer is more urgent, hyperbolically**: at the horizon urgency is exactly 0.5, and it
 *   approaches zero without ever arriving there, which leaves "expired" as the only thing that
 *   reaches it.
 */
export function urgencyOf(actWithinSeconds: number | null, cfg: TriggerConfig): number {
  if (actWithinSeconds === null) return cfg.noDeadlineUrgency;

  const effective = actWithinSeconds - cfg.speakLatencySeconds;
  if (effective <= 0) return 0;

  return cfg.urgencyHorizonSeconds / (cfg.urgencyHorizonSeconds + effective);
}

/** 0..1. A detector that returns something outside it is clamped rather than trusted. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export interface SalienceOptions {
  /**
   * `PlayerMemory.adviceTendency`, resolved at preamble time (ADR-0013, coaching §6.2).
   *
   * The identity is what a first-ever match gets, and it is also what every test gets unless it is
   * the test for this factor — which keeps the other salience assertions readable.
   */
  readonly tendency?: TendencyIndex;
}

export function createSalienceScorer(options: SalienceOptions = {}): SalienceScorer {
  const tendency = options.tendency ?? ((): number => 1);

  return {
    score(detection: Detection, cfg: TriggerConfig): number {
      const weight = cfg.kindWeight[detection.kind];
      const magnitude = clamp01(detection.magnitude);
      const urgency = urgencyOf(detection.actWithinSeconds, cfg);
      const confidence = clamp01(detection.confidence);
      // Not clamped to 1: a tendency above 1 is how durable memory says "this player acts on this
      // kind of advice", and capping it would make the factor one-directional.
      const bias = Math.max(0, tendency(detection.topic));

      return weight * magnitude * urgency * confidence * bias;
    },
  };
}

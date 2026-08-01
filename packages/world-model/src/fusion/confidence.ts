/**
 * The confidence gate.
 *
 * Below threshold a fact is **dropped, not softened**. The alternative — admitting it with a low
 * score and letting the renderer hedge — puts the decision in the layer least able to make it, and
 * dota2 §4 rule 3 is unambiguous that silence beats a confident hallucination in a voice product.
 *
 * Thresholds are per detector and are not decided yet: they depend on the minimap CV spike, which
 * dota2 §10.3 names as the load-bearing assumption of the entire vision layer
 * (state-capture-architecture.md §11.6).
 */

import type { Confidence, DetectorId, Fact } from '../fact.js';

export interface ConfidenceGate {
  admit(fact: Fact<unknown>, detector: DetectorId): boolean;
  thresholdFor(detector: DetectorId): Confidence;
}

/**
 * The threshold a detector with no entry of its own gets.
 *
 * 0.5, matching `packages/context`'s `DEFAULT_AGE_OPTIONS.confidenceFloor`. The two are separate
 * gates on purpose — this one drops the fact, that one declines to render it — but a renderer
 * floor *above* the admission floor would mean facts that land in the model and can never be
 * spoken, so they start equal and any divergence should be deliberate.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5 as Confidence;

export function createConfidenceGate(
  thresholds: ReadonlyMap<DetectorId, Confidence> = new Map(),
  fallback: Confidence = DEFAULT_CONFIDENCE_THRESHOLD,
): ConfidenceGate {
  return {
    thresholdFor(detector: DetectorId): Confidence {
      return thresholds.get(detector) ?? fallback;
    },

    admit(fact: Fact<unknown>, detector: DetectorId): boolean {
      // gsi, log and api are 1.0 by construction (fact.ts), so gating them would be a no-op that
      // reads as though it might one day fail. `derived` is gated by its rule returning null.
      if (fact.source !== 'cv') return true;
      return fact.confidence >= (thresholds.get(detector) ?? fallback);
    },
  };
}

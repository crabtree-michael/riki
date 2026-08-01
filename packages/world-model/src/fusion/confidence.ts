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

export declare function createConfidenceGate(
  thresholds: ReadonlyMap<DetectorId, Confidence>,
): ConfidenceGate;

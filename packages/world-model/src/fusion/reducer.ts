/**
 * Fusion — the keystone.
 *
 * No `this`, no clock, no I/O, no allocation the caller cannot see. A fusion test is: construct a
 * state, apply an observation, assert the next state. Milliseconds, no fixtures, no listener.
 *
 * This purity is ADR-0014 and it is the constraint most likely to be eroded by a convenient
 * shortcut. If the reducer ever needs the time, it takes it as a parameter; if it ever needs to
 * fetch something, the design is wrong and the fetch belongs in the composition root.
 *
 * See docs/design/state-capture-architecture.md §5.2.
 */

import type { Observation } from '../observation.js';
import type { FieldPath, WorldState } from '../state.js';
import type { MonoMs } from '../time.js';
import type { ConfidenceGate } from './confidence.js';
import type { PrecedencePolicy } from './precedence.js';
import type { StalenessPolicy } from './staleness.js';

export interface FusionPolicies {
  readonly precedence: PrecedencePolicy;
  readonly confidence: ConfidenceGate;
  readonly staleness: StalenessPolicy;
}

/**
 * Kept for telemetry. "CV facts stopped landing three patches ago" is exactly the kind of failure
 * that presents as *nothing*, and a counter is the cheapest possible detector for it.
 */
export interface RejectionReason {
  readonly field: FieldPath;
  readonly why:
    'lower_rank' | 'gsi_shadow' | 'older' | 'lower_confidence' | 'below_threshold' | 'unparsed';
}

export interface FusionOutcome {
  /** Referentially identical to the input state when nothing changed — cheap to test for. */
  readonly state: WorldState;
  readonly rejections: readonly RejectionReason[];
}

export type FusionReducer = (
  state: WorldState,
  o: Observation,
  now: MonoMs,
  policies: FusionPolicies,
) => FusionOutcome;

export declare const fuse: FusionReducer;

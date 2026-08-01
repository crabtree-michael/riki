/**
 * Rank the candidates, ask the gates about the winner, return a value.
 *
 * Two rules, and both are `coaching-architecture.md` §6.5's:
 *
 * - **One trigger, one utterance.** The highest-salience candidate is the only one considered.
 *   There is no fall-through to the runner-up, because the gates that would refuse the winner are
 *   mostly about *Riki* — speaking, muted, in a fight, on cooldown — rather than about the
 *   candidate, so falling through would say something less useful for a reason that applies to it
 *   equally. The one exception, `latched`, is per-candidate, and letting it fall through would mean
 *   a latched high-salience condition quietly promoting whatever happened to be second.
 * - **Nothing throws.** A refusal is a `TriggerDecision` with a reason on it, which is what makes
 *   the whole ladder a table test and what makes "every refusal is recorded" mechanical rather than
 *   remembered.
 *
 * See docs/design/coaching-trigger-architecture.md §5.5.
 */

import type { GateContext, TriggerPolicy } from './contracts.js';
import type { Gate } from './contracts.js';
import type { CoachEvent, TriggerDecision } from './types.js';
import { GATES } from './gates/index.js';

/**
 * Highest salience first; ties broken by kind weight and then by key, so the ordering is total.
 *
 * A total order matters more than it looks: without one, two candidates that score identically
 * would be ranked by whatever order the detectors happened to run in, and the golden corpus would
 * be sensitive to a reordering in `DETECTORS` that changes nothing about the design.
 */
export function rank(candidates: readonly CoachEvent[]): readonly CoachEvent[] {
  return [...candidates].sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

export function createTriggerPolicy(gates: readonly Gate[] = GATES): TriggerPolicy {
  return {
    decide(candidates: readonly CoachEvent[], ctx: GateContext): TriggerDecision {
      const ranked = rank(candidates);
      const winner = ranked[0];
      // Nothing was detected, which is not a suppression. `event: null` is how that is said, and
      // the engine neither counts nor reports it — a match where nothing happened and a match where
      // everything was refused are the two readings §5.4 exists to keep apart.
      if (winner === undefined) {
        return { speak: false, reason: 'below_threshold', event: null };
      }

      for (const gate of gates) {
        if (gate.refuses(winner, ctx)) {
          return { speak: false, reason: gate.reason, event: winner };
        }
      }

      return { speak: true, event: winner };
    },
  };
}

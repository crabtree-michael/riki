/**
 * What the coach has said, this match — a ring, not a ledger.
 *
 * The conversation ledger (ADR-0012) is the record of what the *session* was told, it survives a
 * compaction and a reconnect, and it is projected on every novelty-gate read. This is none of those
 * things. It is a handful of the coach's own recent lines, read back into the next stimulus so the
 * model can see what it has already covered.
 *
 * Two properties matter and both are easy to lose:
 *
 * - **It refuses nothing.** It is an input to a judgement, not a gate. `packages/events` has
 *   `already_advised` and `ignored_twice` and this deliberately has no equivalent — requirement 2
 *   puts that call with the model, and a model that can see it said something forty seconds ago is
 *   in a better position to decide whether to say it again than a rule that only knows it did.
 * - **It holds the coach's words, not the player's.** ADR-0013's prohibition is on *durable*
 *   free text; this dies with the match and never reaches `PlayerObservation`. Nothing the player
 *   said is representable here at all, which is the cheapest way to keep that true.
 *
 * See docs/design/llm-coach-architecture.md §4.4.
 */

import type { GameClock, MonoMs } from '@riki/world-model';
import type { CoachRecord } from './contracts.js';
import type { CoachUtterance, SpokenNote } from './types.js';

/**
 * How many notes are kept at all.
 *
 * Larger than `spokenHistoryDepth` on purpose: the config decides how many the *model* is shown and
 * this decides how many exist, so raising the former is a config change rather than a code one.
 */
const CAPACITY = 32;

export function createCoachRecord(): CoachRecord {
  const notes: SpokenNote[] = [];
  let last: MonoMs | null = null;

  return {
    note(utterance: CoachUtterance, clock: GameClock | null): void {
      notes.push({
        atClock: clock,
        at: utterance.at,
        text: utterance.say,
        kind: utterance.kind,
      });
      if (notes.length > CAPACITY) notes.splice(0, notes.length - CAPACITY);
      last = utterance.at;
    },

    recent(n: number): readonly SpokenNote[] {
      if (n <= 0) return [];
      // Newest last, which is the order a model reads a history in — the same order the ledger's
      // rehydration summary renders, and the opposite of what `Array.slice(0, n)` would give.
      return notes.slice(-n);
    },

    lastSpokeAt(): MonoMs | null {
      return last;
    },

    clear(): void {
      notes.length = 0;
      last = null;
    },
  };
}

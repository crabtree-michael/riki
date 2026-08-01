/**
 * The snapshot's `recent:` line.
 *
 * `packages/context` declares the port (`EventTapeReader`) and this package implements it, wired in
 * the composition root — the inversion that keeps `packages/context` free of any import of
 * `@riki/events` while the data flows the way dota2 §3's diagram says (context-and-memory §8.2).
 *
 * **It records detections, not utterances**, and that is the whole point of it. The `recent:` line
 * is *what has been happening in this match*; if it became *what Riki chose to talk about*, a model
 * shown only its own past advice would have no idea what it missed. So anything clearing
 * `tapeSalience` is taped whether or not it was spoken, and the gates do not touch it. The one
 * exception is `not_in_match`, applied by the engine for the same reason it is gate 1: a tape entry
 * about an Ability Draft timing is wrong rather than merely unspoken.
 *
 * See docs/design/coaching-trigger-architecture.md §6.
 */

import type { GameClock, TapeEvent } from '@riki/context';
import type { EventTape } from './contracts.js';
import type { CoachEvent } from './types.js';

interface Entry {
  readonly event: TapeEvent;
  readonly salience: number;
  readonly seq: number;
}

export interface EventTapeOptions {
  /** How many entries to keep. The renderer asks for a handful; the rest are history. */
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 64;

export function createEventTape(options: EventTapeOptions = {}): EventTape {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  let entries: Entry[] = [];
  let seq = 0;

  return {
    record(event: CoachEvent): void {
      // A detection with no game clock happened before the horn, and the `recent:` line renders
      // clock times. Stamping it zero would put a draft-time event at 0:00 of the match.
      if (event.detection.atGameClock === null) return;

      seq += 1;
      entries.push({
        event: {
          id: event.id,
          at: event.detection.atGameClock,
          text: event.detection.text,
        },
        salience: event.salience,
        seq,
      });
      if (entries.length > capacity) entries = entries.slice(entries.length - capacity);
    },

    /**
     * Top-`n` **by salience**, then ordered **newest last**.
     *
     * Both halves are load-bearing and the combination reads oddly until you see why: priority
     * decides what survives the budget, and chronology decides how it reads. The snapshot renderer
     * truncates the tape first when the budget is tight (context-and-memory §5.2), so the tape has
     * to hand it the most important entries — but a list in salience order reads as a *ranking*,
     * and the model would draw an ordering conclusion that is not there.
     */
    recent(n: number, since: GameClock | null): readonly TapeEvent[] {
      if (n <= 0) return [];
      const eligible =
        since === null ? entries : entries.filter((entry) => entry.event.at >= since);

      return [...eligible]
        .sort((a, b) => (b.salience !== a.salience ? b.salience - a.salience : b.seq - a.seq))
        .slice(0, n)
        .sort((a, b) => a.seq - b.seq)
        .map((entry) => entry.event);
    },

    clear(): void {
      entries = [];
      seq = 0;
    },
  };
}

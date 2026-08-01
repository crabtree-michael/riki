/**
 * Bounded history.
 *
 * Bounded by time *and* entry count: a five-minute window is unbounded in a pathological match,
 * and this process runs for hours next to a game that needs the memory.
 *
 * See docs/design/state-capture-architecture.md §5.8.
 */

import type { GameClock, MonoMs } from '../time.js';

export interface RingHistoryOptions {
  /** dota2 §4 asks for ~5 minutes. */
  readonly windowSeconds: number;
  readonly maxEntries: number;
}

export interface RingHistory<T> {
  push(entry: T, at: GameClock | null, now: MonoMs): void;
  /** Entries at or after `clock`, oldest first. Empty rather than throwing if all have evicted. */
  since(clock: GameClock): readonly T[];
  last(n: number): readonly T[];
  readonly size: number;
}

interface Slot<T> {
  readonly entry: T;
  readonly at: GameClock | null;
  readonly now: MonoMs;
}

/**
 * Eviction runs on push, against both clocks.
 *
 * The two-clock rule (fusion/staleness.ts) applies here too and for the same reason: a match
 * paused for four minutes must not lose its history, so entries carrying a match clock age in
 * match time. Entries recorded before the horn have no match clock at all — draft and loading —
 * and fall back to wall time, which is the only clock they ever had.
 */
export function createRingHistory<T>(opts: RingHistoryOptions): RingHistory<T> {
  const { windowSeconds, maxEntries } = opts;
  const windowMs = windowSeconds * 1000;
  // Oldest first. Push appends and is the hot path; eviction slices from the front and is rare.
  // At 2–8 Hz over a five-minute window this array stays small enough that the plainness is worth
  // more than a true circular buffer would be.
  let slots: Slot<T>[] = [];

  const evict = (newestAt: GameClock | null, now: MonoMs): void => {
    let firstKept = 0;
    while (firstKept < slots.length) {
      const slot = slots[firstKept];
      if (slot === undefined) break;
      const tooOld =
        slot.at !== null && newestAt !== null
          ? newestAt - slot.at > windowSeconds
          : now - slot.now > windowMs;
      if (!tooOld) break;
      firstKept += 1;
    }

    // Then the hard cap, which is what keeps the bound while the clock is frozen or absent.
    const overflow = Math.max(0, slots.length - firstKept - maxEntries);
    const cut = firstKept + overflow;
    if (cut > 0) slots = slots.slice(cut);
  };

  return {
    push(entry: T, at: GameClock | null, now: MonoMs): void {
      slots.push({ entry, at, now });
      evict(at, now);
    },

    since(clock: GameClock): readonly T[] {
      // Entries with no match clock are skipped rather than guessed at: they were recorded before
      // the horn, and answering a match-clock question with one would misstate when it happened.
      // `last()` is the accessor that still sees them.
      return slots.filter((slot) => slot.at !== null && slot.at >= clock).map((slot) => slot.entry);
    },

    last(n: number): readonly T[] {
      if (n <= 0) return [];
      return slots.slice(Math.max(0, slots.length - n)).map((slot) => slot.entry);
    },

    get size(): number {
      return slots.length;
    },
  };
}

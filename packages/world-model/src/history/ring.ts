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

export declare function createRingHistory<T>(opts: RingHistoryOptions): RingHistory<T>;

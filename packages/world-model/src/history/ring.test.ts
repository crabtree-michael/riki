/**
 * Tier 1. §10 asks for eviction by both the window and the entry cap, because either one alone
 * is unbounded in a case that actually happens: a five-minute window is unbounded in a chaotic
 * match, and an entry cap alone keeps hours-old entries in a quiet one.
 */

import { describe, expect, it } from 'vitest';
import { asGameClock, asMonoMs } from '../time.js';
import { createRingHistory } from './ring.js';

describe('RingHistory', () => {
  it('evicts by the match-clock window', () => {
    const ring = createRingHistory<string>({ windowSeconds: 300, maxEntries: 1000 });
    ring.push('old', asGameClock(0), asMonoMs(0));
    ring.push('recent', asGameClock(290), asMonoMs(290_000));
    ring.push('now', asGameClock(400), asMonoMs(400_000));

    expect(ring.last(10)).toEqual(['recent', 'now']);
  });

  it('evicts by the entry cap even inside the window', () => {
    const ring = createRingHistory<number>({ windowSeconds: 300, maxEntries: 3 });
    for (let i = 0; i < 10; i += 1) ring.push(i, asGameClock(i), asMonoMs(i * 10));
    expect(ring.last(10)).toEqual([7, 8, 9]);
    expect(ring.size).toBe(3);
  });

  it('ages pre-horn entries in wall time, which is the only clock they have', () => {
    // Draft chat has no match clock. Without this fallback it would never evict at all.
    const ring = createRingHistory<string>({ windowSeconds: 60, maxEntries: 1000 });
    ring.push('draft', null, asMonoMs(0));
    ring.push('later', null, asMonoMs(90_000));
    expect(ring.last(10)).toEqual(['later']);
  });

  it('answers `since` with entries at or after the clock, oldest first', () => {
    const ring = createRingHistory<string>({ windowSeconds: 600, maxEntries: 100 });
    ring.push('a', asGameClock(100), asMonoMs(100_000));
    ring.push('b', asGameClock(200), asMonoMs(200_000));
    ring.push('c', asGameClock(300), asMonoMs(300_000));

    expect(ring.since(asGameClock(200))).toEqual(['b', 'c']);
    expect(ring.since(asGameClock(900))).toEqual([]);
  });

  it('skips clockless entries in `since` rather than misdating them', () => {
    // Answering a match-clock question with a pre-horn entry would claim it happened in-match.
    const ring = createRingHistory<string>({ windowSeconds: 600, maxEntries: 100 });
    ring.push('draft', null, asMonoMs(0));
    ring.push('inmatch', asGameClock(100), asMonoMs(100_000));

    expect(ring.since(asGameClock(0))).toEqual(['inmatch']);
    expect(ring.last(10)).toEqual(['draft', 'inmatch']);
  });

  it('survives a paused match without losing history', () => {
    // Ninety wall seconds, no clock movement: nothing may evict, because nothing got older.
    const ring = createRingHistory<string>({ windowSeconds: 60, maxEntries: 100 });
    ring.push('before', asGameClock(600), asMonoMs(0));
    ring.push('during', asGameClock(600), asMonoMs(90_000));
    expect(ring.last(10)).toEqual(['before', 'during']);
  });
});

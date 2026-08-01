/**
 * Tier 1. §10 asks for exactly one thing here: age across a simulated pause, asserting the
 * two-clock rule. That is the test, and the rest is the table lookup that makes it reachable.
 */

import { describe, expect, it } from 'vitest';
import type { Confidence, Fact } from '../fact.js';
import { fieldPath } from '../state.js';
import { asGameClock, asMonoMs } from '../time.js';
import { ageInBasis, createStalenessPolicy } from './staleness.js';

const fact = (observedAt: number, atGameClock: number | null): Fact<unknown> => ({
  value: 1,
  source: 'cv',
  confidence: 1 as Confidence,
  observedAt: asMonoMs(observedAt),
  atGameClock: atGameClock === null ? null : asGameClock(atGameClock),
});

const policy = createStalenessPolicy();

describe('the two-clock rule', () => {
  it('freezes a tactical fact through a pause', () => {
    // Forty wall seconds pass with the match clock frozen at 600. An enemy position from "ten
    // seconds ago" is still exactly true — nothing on the map moved — so it must not age out.
    const position = fact(0, 600);
    const path = fieldPath('enemies', 'sf', 'position');

    const age = ageInBasis(position, asMonoMs(40_000), asGameClock(600), 'game');
    expect(age).toEqual({ ms: 0, basis: 'game' });
    expect(policy.classify(path, position, asMonoMs(40_000), asGameClock(600))).toBe('fresh');
  });

  it('keeps ageing a pipeline fact through the same pause', () => {
    // `meta.*` is on the wall basis, because a client that has not POSTed for forty seconds of
    // paused game is still gone and the model must be able to say so.
    const clockFact = fact(0, 600);
    const path = fieldPath('meta', 'clock');

    expect(ageInBasis(clockFact, asMonoMs(40_000), asGameClock(600), 'wall')).toEqual({
      ms: 40_000,
      basis: 'wall',
    });
    expect(policy.classify(path, clockFact, asMonoMs(40_000), asGameClock(600))).toBe('expired');
  });

  it('falls back to wall time when the match has no clock at either end', () => {
    // Draft and loading have no clock, and refusing to age anything then would be worse than
    // ageing it on the only clock that exists.
    expect(ageInBasis(fact(0, null), asMonoMs(5_000), asGameClock(600), 'game')).toEqual({
      ms: 5_000,
      basis: 'wall',
    });
    expect(ageInBasis(fact(0, 600), asMonoMs(5_000), null, 'game')).toEqual({
      ms: 5_000,
      basis: 'wall',
    });
  });

  it('clamps a reordered fact to zero rather than calling it fresh forever', () => {
    // A fact stamped ahead of `clock` is a late-arriving observation, not one from the future.
    expect(ageInBasis(fact(0, 620), asMonoMs(0), asGameClock(600), 'game').ms).toBe(0);
  });
});

describe('classification', () => {
  const path = fieldPath('enemies', 'sf', 'position');
  const seen = fact(0, 600);
  const nowAt = (gameSeconds: number) =>
    policy.classify(path, seen, asMonoMs(gameSeconds * 1000), asGameClock(600 + gameSeconds));

  it('walks fresh → aging → stale → expired as the match clock advances', () => {
    expect(nowAt(1)).toBe('fresh');
    expect(nowAt(4)).toBe('aging');
    expect(nowAt(10)).toBe('stale');
    expect(nowAt(25)).toBe('expired');
  });

  it('expires a position long before it expires the last-seen hypothesis', () => {
    // This is the mechanism behind §3.5: `position` dies, `lastSeenAt` survives it, and the
    // renderer says "last seen mid ~25s ago" instead of dropping the hero from the list.
    const lastSeen = fieldPath('enemies', 'sf', 'lastSeenAt');
    expect(policy.classify(path, seen, asMonoMs(25_000), asGameClock(625))).toBe('expired');
    expect(policy.classify(lastSeen, seen, asMonoMs(25_000), asGameClock(625))).not.toBe('expired');
  });
});

describe('policy lookup', () => {
  it('prefers the more specific pattern regardless of insertion order', () => {
    expect(policy.policyFor(fieldPath('map', 'roshanState')).expiredMs).toBe(900_000);
    expect(policy.policyFor(fieldPath('map', 'daytime')).expiredMs).toBe(120_000);
  });

  it('falls back for a field nobody wrote a policy for, rather than never ageing it', () => {
    const fallback = policy.policyFor(fieldPath('enemies', 'sf', 'somethingNew'));
    expect(fallback.expiredMs).toBeGreaterThan(0);
  });
});

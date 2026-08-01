/**
 * Tier 1. The envelope is the central type of the subsystem, so the properties worth pinning are
 * the ones that make it impossible to construct a dishonest fact rather than merely unusual.
 */

import { describe, expect, it } from 'vitest';
import type { Fact } from './fact.js';
import { asConfidence, asDetectorId, cvFact, derivedFact, gsiFact, logFact } from './fact.js';
import { asGameClock, asMonoMs } from './time.js';

const at = (observedAt: number, clock: number | null = 600) => ({
  observedAt: asMonoMs(observedAt),
  atGameClock: clock === null ? null : asGameClock(clock),
});

describe('factories', () => {
  it('gives the exact sources confidence 1.0 by construction, not by convention', () => {
    expect(gsiFact(1, at(0)).confidence).toBe(1);
    expect(logFact(1, at(0)).confidence).toBe(1);
  });

  it('requires a confidence and a detector for a CV fact', () => {
    // The point of the whole ceremony: a CV position constructible without a score would
    // eventually be rendered as though it were certain (REPO_SKELETON §4).
    const fact = cvFact(1, at(0), asConfidence(0.62), asDetectorId('minimap'));
    expect(fact.source).toBe('cv');
    expect(fact.confidence).toBe(0.62);
    expect(fact.origin).toBe('minimap');
  });

  it('refuses a confidence outside 0–1 rather than clamping it', () => {
    expect(() => asConfidence(1.4)).toThrow(RangeError);
    expect(() => asConfidence(Number.NaN)).toThrow(RangeError);
  });

  it('stores no age, because a stored age is wrong by the time it is read', () => {
    expect(Object.keys(gsiFact(1, at(0)))).not.toContain('age');
  });

  it('omits `origin` entirely rather than setting it undefined', () => {
    // `exactOptionalPropertyTypes` is on; an explicit undefined would not even typecheck for a
    // consumer, and would serialise differently across the protocol boundary.
    expect('origin' in gsiFact(1, at(0))).toBe(false);
  });
});

describe('derivedFact', () => {
  it('inherits the minimum confidence of its inputs', () => {
    const inputs: Fact<unknown>[] = [
      gsiFact(1, at(0)),
      cvFact(2, at(0), asConfidence(0.55), asDetectorId('topbar')),
    ];
    expect(derivedFact('answer', at(1000), inputs).confidence).toBe(0.55);
  });

  it('inherits the oldest observedAt, and the clock that goes with it', () => {
    // "Gold until Diffusal", computed from a stale net-worth estimate, is itself stale — and its
    // two timestamps have to describe one moment, not two.
    const inputs = [gsiFact(1, at(9_000, 690)), gsiFact(2, at(3_000, 600))];
    const fact = derivedFact('answer', at(10_000, 700), inputs);

    expect(fact.observedAt).toBe(3_000);
    expect(fact.atGameClock).toBe(600);
  });

  it('takes the given timestamps when it has no inputs, for a structural default', () => {
    const fact = derivedFact('idle', at(500), []);
    expect(fact.observedAt).toBe(500);
    expect(fact.confidence).toBe(1);
  });
});

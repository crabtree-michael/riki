/**
 * The decomposition, and the one assertion `coaching-architecture.md` §13 names by hand:
 * **a 0.55-confidence detection scores below the same detection from GSI.**
 *
 * That row exists because dropping confidence from the score is the easiest thing in this package
 * to do by accident, and the symptom is not a crash — it is Riki treating a minimap blob and a GSI
 * reading as the same claim, which is the failure the whole fact envelope exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import type { HeroId } from '@riki/world-model';
import { DEFAULT_TRIGGER_CONFIG as CFG, withTriggerConfig } from './config.js';
import { createSalienceScorer, urgencyOf } from './salience.js';
import type { Detection } from './types.js';
import { detectionKey } from './types.js';

const SF = 'sf' as HeroId;

function detection(overrides: Partial<Detection> = {}): Detection {
  return {
    kind: 'enemy_missing',
    key: detectionKey('enemy_missing', 'sf'),
    topic: { of: 'hero', hero: SF },
    magnitude: 1,
    actWithinSeconds: null,
    confidence: 1,
    text: 'sf unseen 40s',
    atGameClock: null,
    ...overrides,
  };
}

describe('urgency', () => {
  it('is zero once the advice would arrive after the window closed', () => {
    expect(urgencyOf(CFG.speakLatencySeconds, CFG)).toBe(0);
    expect(urgencyOf(0, CFG)).toBe(0);
    expect(urgencyOf(-5, CFG)).toBe(0);
  });

  it('is exactly a half at the horizon, past the speaking latency', () => {
    expect(urgencyOf(CFG.urgencyHorizonSeconds + CFG.speakLatencySeconds, CFG)).toBeCloseTo(0.5);
  });

  it('is monotonically decreasing in the deadline', () => {
    const near = urgencyOf(5, CFG);
    const mid = urgencyOf(20, CFG);
    const far = urgencyOf(90, CFG);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it('takes the flat value when there is no deadline at all', () => {
    expect(urgencyOf(null, CFG)).toBe(CFG.noDeadlineUrgency);
  });
});

describe('salience', () => {
  const scorer = createSalienceScorer();

  it('is the product of its five factors', () => {
    const score = scorer.score(detection({ magnitude: 0.5 }), CFG);
    expect(score).toBeCloseTo(CFG.kindWeight.enemy_missing * 0.5 * CFG.noDeadlineUrgency);
  });

  it('ranks a 0.55-confidence detection below the same one from GSI', () => {
    const certain = scorer.score(detection({ confidence: 1 }), CFG);
    const blob = scorer.score(detection({ confidence: 0.55 }), CFG);

    expect(blob).toBeLessThan(certain);
    expect(blob).toBeCloseTo(certain * 0.55);
  });

  it('is zero past a deadline, whatever the kind weight says', () => {
    expect(scorer.score(detection({ kind: 'low_hp_no_escape', actWithinSeconds: 0 }), CFG)).toBe(0);
  });

  it('carries the kind weight, so the same instance of two kinds is ordered by policy', () => {
    const urgent = scorer.score(detection({ kind: 'low_hp_no_escape' }), CFG);
    const routine = scorer.score(detection({ kind: 'ult_ready' }), CFG);
    expect(urgent).toBeGreaterThan(routine);
  });

  it('applies advice tendency, and lets it run above one', () => {
    const eager = createSalienceScorer({ tendency: () => 1.5 });
    const bored = createSalienceScorer({ tendency: () => 0.2 });
    const base = scorer.score(detection(), CFG);

    expect(eager.score(detection(), CFG)).toBeCloseTo(base * 1.5);
    expect(bored.score(detection(), CFG)).toBeCloseTo(base * 0.2);
  });

  it('reads tendency per topic, which is what makes it about a person', () => {
    const picky = createSalienceScorer({
      tendency: (topic) => (topic.of === 'objective' ? 0 : 1),
    });
    expect(picky.score(detection({ topic: { of: 'objective', objective: 'rune' } }), CFG)).toBe(0);
    expect(picky.score(detection(), CFG)).toBeGreaterThan(0);
  });

  it('clamps a detector that returns nonsense rather than trusting it', () => {
    const wild = scorer.score(detection({ magnitude: 4, confidence: 9 }), CFG);
    expect(wild).toBeCloseTo(CFG.kindWeight.enemy_missing * CFG.noDeadlineUrgency);
    expect(scorer.score(detection({ magnitude: Number.NaN }), CFG)).toBe(0);
  });

  it('is the only thing tuning has to move', () => {
    const quieter = withTriggerConfig({
      kindWeight: { ...CFG.kindWeight, enemy_missing: 0.1 },
    });
    expect(scorer.score(detection(), quieter)).toBeLessThan(scorer.score(detection(), CFG));
  });
});

/**
 * Tier 1. Table-driven over the §5.3 matrix, which is the form §10 asks for — the matrix is a
 * table in the design doc and a wrong cell should read as a wrong row here, not as prose.
 */

import { describe, expect, it } from 'vitest';
import type { Confidence, Fact, FactSource } from '../fact.js';
import type { FieldPath } from '../state.js';
import { fieldPath } from '../state.js';
import type { MonoMs } from '../time.js';
import { asMonoMs } from '../time.js';
import { classOfPath, createPrecedencePolicy } from './precedence.js';

const at = (ms: number): MonoMs => asMonoMs(ms);

const fact = (source: FactSource, observedAt: number, confidence = 1): Fact<unknown> => ({
  value: 1,
  source,
  confidence: confidence as Confidence,
  observedAt: at(observedAt),
  atGameClock: null,
});

const policy = createPrecedencePolicy({ gsiShadowWindowMs: 2000, confidenceWindowMs: 2000 });

describe('classOfPath', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['self.health', 'self'],
    ['self.gold', 'self'],
    ['meta.clock', 'meta'],
    ['map.daytime', 'meta'],
    ['map.buildings', 'buildings'],
    ['map.roshanState', 'enemy_liveness'],
    ['map.wardsSeen', 'enemy_position'],
    ['enemies.sf.hero', 'roster'],
    ['enemies.sf.position', 'enemy_position'],
    ['enemies.sf.lastSeenAt', 'enemy_position'],
    ['enemies.sf.alive', 'enemy_liveness'],
    ['enemies.sf.respawnIn', 'enemy_liveness'],
    ['enemies.sf.level', 'enemy_progress'],
    ['enemies.sf.netWorth', 'enemy_progress'],
    ['enemies.sf.itemsSeen.blink', 'enemy_progress'],
    ['allies.cm.position', 'enemy_position'],
  ];

  it.each(cases)('%s is class %s', (path, expected) => {
    expect(classOfPath(path as FieldPath)).toBe(expected);
  });
});

describe('rank — the "never writes" column', () => {
  // These are the cells that make the difference between a coach and a liar. CV on `self.*` is
  // the one dota2 §5.6 is emphatic about: GSI is ground truth there, so a disagreeing CV reading
  // is a calibration signal, never a fact.
  const never: readonly (readonly [string, FactSource])[] = [
    ['self.health', 'cv'],
    ['self.gold', 'log'],
    ['meta.clock', 'cv'],
    ['map.buildings', 'cv'],
    ['enemies.sf.position', 'gsi'],
    ['enemies.sf.level', 'gsi'],
  ];

  it.each(never)('%s refuses a %s fact outright', (path, source) => {
    const verdict = policy.canWrite(path as FieldPath, fact(source, 0), undefined, at(0));
    expect(verdict).toEqual({ write: false, reason: 'lower_rank' });
  });

  it('refuses even when the field is empty and has been for the whole match', () => {
    // Rank 0 is not "lowest priority", it is "never" — no amount of silence unlocks it.
    const verdict = policy.canWrite(
      fieldPath('self', 'health'),
      fact('cv', 600_000),
      undefined,
      at(600_000),
    );
    expect(verdict).toEqual({ write: false, reason: 'lower_rank' });
  });
});

describe('the GSI shadow window', () => {
  const path = fieldPath('enemies', 'sf', 'alive');

  it('blocks a gap-filling source while the authoritative one is still fresh', () => {
    // The kill feed spoke 500 ms ago; a top-bar reading must not race it.
    const verdict = policy.canWrite(path, fact('cv', 500), fact('log', 0), at(500));
    expect(verdict).toEqual({ write: false, reason: 'gsi_shadow' });
  });

  it('lets it through once the authoritative source has actually gone quiet', () => {
    const verdict = policy.canWrite(path, fact('cv', 3000), fact('log', 0), at(3000));
    expect(verdict).toEqual({ write: true });
  });

  it('is the boundary that decides behaviour during a dropout, so it is exact at the edge', () => {
    expect(policy.canWrite(path, fact('cv', 1999), fact('log', 0), at(1999)).write).toBe(false);
    expect(policy.canWrite(path, fact('cv', 2000), fact('log', 0), at(2000)).write).toBe(true);
  });
});

describe('recency', () => {
  const path = fieldPath('enemies', 'sf', 'position');

  it('refuses an observation older than the one already there', () => {
    // §6.2: out-of-order delivery is expected and must be harmless rather than corrupting.
    const verdict = policy.canWrite(path, fact('cv', 1000), fact('cv', 2000), at(2000));
    expect(verdict).toEqual({ write: false, reason: 'older' });
  });

  it('accepts a re-observation at the same instant, because its age has still reset', () => {
    expect(policy.canWrite(path, fact('cv', 2000), fact('cv', 2000), at(2000)).write).toBe(true);
  });
});

describe('confidence within a source', () => {
  const path = fieldPath('enemies', 'sf', 'position');

  it('does not let a 0.55 blob erase a 0.91 sighting from a second ago', () => {
    const verdict = policy.canWrite(path, fact('cv', 1000, 0.55), fact('cv', 0, 0.91), at(1000));
    expect(verdict).toEqual({ write: false, reason: 'lower_confidence' });
  });

  it('does let it through once the confident sighting has stopped being current', () => {
    // A hedged answer beats a confident stale one, which is the whole point of carrying both.
    expect(policy.canWrite(path, fact('cv', 5000, 0.55), fact('cv', 0, 0.91), at(5000)).write).toBe(
      true,
    );
  });

  it('does not apply across sources, where rank and the shadow window already decided', () => {
    const verdict = policy.canWrite(
      fieldPath('enemies', 'sf', 'alive'),
      fact('cv', 3000, 0.6),
      fact('log', 0, 1),
      at(3000),
    );
    expect(verdict).toEqual({ write: true });
  });
});

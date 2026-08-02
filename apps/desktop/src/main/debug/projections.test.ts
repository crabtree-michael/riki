/**
 * The world projection, and the three distinctions it must not flatten.
 *
 * `projectWorld` is the inspector's independent read of `packages/world-model` — deliberately not
 * the snapshot renderer, which elides and phrases things for a ~300-token budget. When the two
 * disagree about what the model holds, the answer is in the difference, so this one has to show
 * every observed leaf with its whole envelope and nothing else.
 *
 * Three cases carry the weight, and all three are places where the obvious implementation says
 * something false:
 *
 * - **Never observed is not null.** `packages/world-model` rule 2. A leaf nothing has written is
 *   omitted, not rendered as a `null` row — the two mean opposite things about the sources, and
 *   sixty null rows would also bury the facts that are real.
 * - **A declined derived rule is not zero.** `null` means the inputs were too stale to answer
 *   honestly, which is the answer; rendering it as `0` invents a number the rule refused to give.
 * - **The envelope is not optional.** Source, confidence, staleness, age and age *basis* travel
 *   with every value, because the basis is what makes an age look wrong during a pause and it is
 *   the one people forget.
 */

import { describe, expect, it } from 'vitest';

import { buildWorld } from '@riki/events/testing';
import type { FieldPath } from '@riki/world-model';
import { createStalenessPolicy } from '@riki/world-model';

import { projectCounters, projectWorld, renderValue } from './projections.js';

const NOW = 60_000;

function project(
  world: ReturnType<typeof buildWorld>,
  now = NOW,
): ReturnType<ReturnType<typeof projectWorld>> {
  return projectWorld({ world: world.reader(), staleness: createStalenessPolicy() })(now);
}

/** A world with a handful of real leaves, at a real match clock. */
function laning(): ReturnType<typeof buildWorld> {
  return buildWorld({ now: NOW, clock: 600 })
    .put('meta.phase' as FieldPath, 'in_progress')
    .put('meta.clock' as FieldPath, 600)
    .put('self.hero' as FieldPath, 'riki')
    .put('self.level' as FieldPath, 9)
    .put('self.health' as FieldPath, { current: 720, max: 1_100 });
}

describe('renderValue', () => {
  it('renders primitives as themselves', () => {
    expect(renderValue('riki')).toBe('riki');
    expect(renderValue(9)).toBe('9');
    expect(renderValue(true)).toBe('true');
    expect(renderValue(0)).toBe('0');
  });

  it('distinguishes null from undefined', () => {
    // Both reach this function and they are different facts about the model: a leaf holding null
    // was observed to be absent, and one holding undefined was never written at all.
    expect(renderValue(null)).toBe('null');
    expect(renderValue(undefined)).toBe('undefined');
  });

  it('renders structured values as JSON, shape included', () => {
    expect(renderValue({ current: 720, max: 1_100 })).toBe('{"current":720,"max":1100}');
    expect(renderValue(['blink', 'force_staff'])).toBe('["blink","force_staff"]');
  });

  it('renders a Map, which JSON.stringify would render as {}', () => {
    // `itemsSeen` is a Map, and the honest failure here is silent: `JSON.stringify(new Map(...))`
    // is `{}`, so an inspector without this branch shows an empty object for a real observation.
    expect(renderValue(new Map([['blink', 1]]))).toBe('{"blink":1}');
  });

  it('truncates a long value with a marker rather than cutting it silently', () => {
    const rendered = renderValue('x'.repeat(500));
    expect(rendered.length).toBeLessThan(500);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('says so rather than throwing when a value cannot be rendered', () => {
    // The world model has no cycles; this runs over `unknown`, and a debug view that throws is
    // worse than one that admits it could not read something.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(renderValue(cyclic)).toBe('<unrenderable>');
  });
});

describe('projectWorld', () => {
  it('omits leaves that were never observed', () => {
    const facts = project(laning()).facts;
    const paths = facts.map((fact) => fact.path);

    expect(paths).toContain('self.hero');
    // `meta.patch`, `self.xp`, `map.roshanState` and the rest are unwritten. Absent, not null.
    expect(paths).not.toContain('meta.patch');
    expect(paths).not.toContain('self.xp');
    expect(paths).not.toContain('map.roshanState');
    expect(facts.every((fact) => fact.value !== 'undefined')).toBe(true);
  });

  it('carries the whole envelope on every fact', () => {
    const hero = project(laning()).facts.find((fact) => fact.path === 'self.hero');

    expect(hero).toBeDefined();
    expect(hero?.value).toBe('riki');
    expect(hero?.source).toBe('gsi');
    expect(hero?.confidence).toBe(1);
    expect(hero?.staleness).toBe('fresh');
    expect(hero?.ageMs).toBe(0);
    // The two-clock rule: the basis is what makes an age look wrong during a pause.
    expect(['wall', 'game']).toContain(hero?.ageBasis);
  });

  it('reports the source and confidence a low-confidence observation actually has', () => {
    // The builder writes anything under full confidence as a CV fact, which is the case where
    // provenance matters most — a CV guess and a GSI certainty must never render alike.
    const world = laning().put('self.gold' as FieldPath, 1_400, { confidence: 0.6 });
    const gold = project(world).facts.find((fact) => fact.path === 'self.gold');

    expect(gold?.source).toBe('cv');
    expect(gold?.confidence).toBeCloseTo(0.6);
  });

  it('ages a fact, and classifies it', () => {
    const world = laning().put('self.gold' as FieldPath, 1_400, { ageSeconds: 30 });
    const gold = project(world).facts.find((fact) => fact.path === 'self.gold');

    expect(gold?.ageMs).toBe(30_000);
    expect(gold?.staleness).not.toBe('fresh');
  });

  it('renders a structured leaf rather than dropping it', () => {
    const health = project(laning()).facts.find((fact) => fact.path === 'self.health');
    expect(health?.value).toBe('{"current":720,"max":1100}');
  });

  it('reads the version, the clock and the pause flag', () => {
    const world = laning().put('meta.paused' as FieldPath, true);
    world.commit();
    const projected = project(world);

    expect(projected.clock).toBe(600);
    expect(projected.paused).toBe(true);
    expect(projected.version).toBeGreaterThan(0);
  });

  it('treats a missing pause flag as not paused, not as unknown', () => {
    expect(project(laning()).paused).toBe(false);
  });

  it('projects enemies, keeping unseen distinct from absent', () => {
    const world = laning()
      .put('enemies.shadow_fiend.position' as FieldPath, { x: 100, y: -40 })
      .put('enemies.shadow_fiend.level' as FieldPath, 11)
      .put('enemies.pudge.level' as FieldPath, 8);

    const enemies = project(world).enemies;
    const sf = enemies.find((enemy) => enemy.hero === 'shadow_fiend');
    const pudge = enemies.find((enemy) => enemy.hero === 'pudge');

    expect(sf?.position).toBe('{"x":100,"y":-40}');
    expect(sf?.level).toBe(11);
    // Never seen on the map: null position, and `expired` rather than a staleness that implies
    // there was once an observation to age.
    expect(pudge?.position).toBeNull();
    expect(pudge?.staleness).toBe('expired');
  });

  it('shows a declined derived rule as null rather than as zero', () => {
    // Nearly nothing is written, so most rules cannot answer. `null` is the answer they gave.
    const derived = project(buildWorld({ now: NOW, clock: 600 })).derived;

    expect(derived.length).toBeGreaterThan(0);
    const declined = derived.filter((rule) => rule.value === null);
    expect(declined.length).toBeGreaterThan(0);
    for (const rule of declined) {
      expect(rule.value).toBeNull();
      expect(rule.confidence).toBeNull();
      expect(rule.value).not.toBe('0');
    }
  });

  it('names every derived rule, answered or not', () => {
    const derived = project(laning()).derived;
    expect(new Set(derived.map((rule) => rule.id)).size).toBe(derived.length);
    expect(derived.every((rule) => rule.id.length > 0)).toBe(true);
  });

  it('follows the key arrays, so a new world-model field needs no change here', () => {
    // The path list is built from META_KEYS/SELF_KEYS/MAP_KEYS rather than written out, which is
    // what keeps this file from silently falling behind `state.ts` as fields are added.
    const world = buildWorld({ now: NOW, clock: 600 })
      .put('meta.mode' as FieldPath, 'all_pick')
      .put('map.daytime' as FieldPath, true);
    const paths = project(world).facts.map((fact) => fact.path);

    expect(paths).toContain('meta.mode');
    expect(paths).toContain('map.daytime');
  });
});

describe('projectCounters', () => {
  it('flattens both halves and sorts by count, then by key', () => {
    const projected = projectCounters({
      detected: { rune_soon: 3, ult_ready: 7, gank_risk: 3 },
      suppressed: { kind_cooldown: 5 },
      spoken: 2,
    });

    expect(projected.detected).toEqual([
      { key: 'ult_ready', count: 7 },
      // Ties break alphabetically so the display does not jitter between frames.
      { key: 'gank_risk', count: 3 },
      { key: 'rune_soon', count: 3 },
    ]);
    expect(projected.suppressed).toEqual([{ key: 'kind_cooldown', count: 5 }]);
    expect(projected.spoken).toBe(2);
  });

  it('keeps both halves when one is empty', () => {
    // §5.4's distinction: nothing detected and everything suppressed are different failures, and a
    // projection that dropped an empty half would make them look the same.
    const projected = projectCounters({
      detected: {},
      suppressed: { not_in_match: 900 },
      spoken: 0,
    });

    expect(projected.detected).toEqual([]);
    expect(projected.suppressed).toHaveLength(1);
  });
});

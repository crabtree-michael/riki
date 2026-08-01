/**
 * The three inputs dota2 §6.4 names, and the reason they are combined with `Math.max`.
 *
 * Each one alone has to be able to raise the score, because they are three pieces of evidence for
 * one thing rather than three things that add up: somebody at full health surrounded by four
 * enemies is in a fight, and so is somebody alone who just lost most of their health to a gank.
 */

import { describe, expect, it } from 'vitest';
import type { AbilityState, FieldPath, HeroId, MapPosition } from '@riki/world-model';
import { fieldPath, heroField } from '@riki/world-model';
import { DEFAULT_TRIGGER_CONFIG as CFG } from './config.js';
import { createIntensityMonitor } from './intensity.js';
import { buildWorld } from './testing/index.js';

const SELF_HEALTH: FieldPath = fieldPath('self', 'health');
const SELF_POSITION: FieldPath = fieldPath('self', 'position');
const SELF_ABILITIES: FieldPath = fieldPath('self', 'abilities');
const HERE: MapPosition = { x: 0, y: 0 };
const FAR: MapPosition = { x: 9_000, y: 9_000 };

function ability(id: string, castable: boolean): AbilityState {
  return { id, level: 1, cooldown: 0, castable, isUltimate: false } as AbilityState;
}

describe('intensity', () => {
  it('is zero in a quiet world', () => {
    const world = buildWorld()
      .put(SELF_POSITION, HERE)
      .put(SELF_HEALTH, { current: 1000, max: 1000 });
    world.commit();
    expect(createIntensityMonitor().score(world.snapshot(), CFG)).toBe(0);
  });

  it('rises on a health swing alone', () => {
    const monitor = createIntensityMonitor();
    const world = buildWorld()
      .put(SELF_POSITION, FAR)
      .put(SELF_HEALTH, { current: 1000, max: 1000 });
    world.commit();

    world.advance(1).put(SELF_HEALTH, { current: 550, max: 1000 });
    monitor.observe(world.commit(), world.snapshot());

    expect(monitor.score(world.snapshot(), CFG)).toBeGreaterThanOrEqual(1);
  });

  it('ignores healing — going up is not a fight', () => {
    const monitor = createIntensityMonitor();
    const world = buildWorld()
      .put(SELF_POSITION, FAR)
      .put(SELF_HEALTH, { current: 300, max: 1000 });
    world.commit();

    world.advance(1).put(SELF_HEALTH, { current: 1000, max: 1000 });
    monitor.observe(world.commit(), world.snapshot());

    expect(monitor.score(world.snapshot(), CFG)).toBe(0);
  });

  it('rises on nearby enemies alone, with nothing else moving', () => {
    const world = buildWorld().put(SELF_POSITION, HERE);
    for (const hero of ['sf', 'cm', 'zeus']) {
      world.put(heroField('enemies', hero as HeroId, 'position'), HERE);
    }
    world.commit();

    expect(createIntensityMonitor().score(world.snapshot(), CFG)).toBeGreaterThanOrEqual(1);
  });

  it('does not count enemies on the other side of the map', () => {
    const world = buildWorld().put(SELF_POSITION, HERE);
    for (const hero of ['sf', 'cm', 'zeus']) {
      world.put(heroField('enemies', hero as HeroId, 'position'), FAR);
    }
    world.commit();

    expect(createIntensityMonitor().score(world.snapshot(), CFG)).toBe(0);
  });

  it('does not count a stale sighting as somebody standing next to you', () => {
    const world = buildWorld().put(SELF_POSITION, HERE);
    for (const hero of ['sf', 'cm', 'zeus']) {
      world.put(heroField('enemies', hero as HeroId, 'position'), HERE, { ageSeconds: 30 });
    }
    world.commit();

    expect(createIntensityMonitor().score(world.snapshot(), CFG)).toBe(0);
  });

  it('rises on cast rate alone', () => {
    const monitor = createIntensityMonitor();
    const world = buildWorld().put(SELF_POSITION, FAR);
    const ids = ['a', 'b', 'c', 'd'];
    world.put(
      SELF_ABILITIES,
      ids.map((id) => ability(id, true)),
    );
    world.commit();

    world.advance(1).put(
      SELF_ABILITIES,
      ids.map((id) => ability(id, false)),
    );
    monitor.observe(world.commit(), world.snapshot());

    expect(monitor.score(world.snapshot(), CFG)).toBeGreaterThanOrEqual(1);
  });

  it('counts the moment of use, not the cooldown ticking down', () => {
    const monitor = createIntensityMonitor();
    const world = buildWorld().put(SELF_POSITION, FAR);
    world.put(SELF_ABILITIES, [ability('a', false)]);
    world.commit();

    world.advance(1).put(SELF_ABILITIES, [ability('a', false)]);
    monitor.observe(world.commit(), world.snapshot());

    expect(monitor.score(world.snapshot(), CFG)).toBe(0);
  });

  it('ages samples out of the window on the game clock', () => {
    const monitor = createIntensityMonitor();
    const world = buildWorld()
      .put(SELF_POSITION, FAR)
      .put(SELF_HEALTH, { current: 1000, max: 1000 });
    world.commit();

    world.advance(1).put(SELF_HEALTH, { current: 550, max: 1000 });
    monitor.observe(world.commit(), world.snapshot());
    expect(monitor.score(world.snapshot(), CFG)).toBeGreaterThan(0);

    world.advance(CFG.intensityWindowSeconds + 1);
    expect(monitor.score(world.snapshot(), CFG)).toBe(0);
  });

  it('drops pre-horn samples rather than stamping them at clock zero', () => {
    const monitor = createIntensityMonitor();
    const world = buildWorld({ clock: null })
      .put(SELF_POSITION, FAR)
      .put(SELF_HEALTH, { current: 1000, max: 1000 });
    world.commit();

    world.put(SELF_HEALTH, { current: 100, max: 1000 });
    monitor.observe(world.commit(), world.snapshot());

    expect(monitor.score(world.snapshot(), CFG)).toBe(0);
  });
});

/**
 * The engine, which owns the four things nothing else can: the latch set, the cooldown clocks, the
 * counters, and the subscription.
 *
 * The blocks that matter most are the latch ones. `coaching-architecture.md` §6.3 calls `latched`
 * the gate both documents had missed, and its failure mode is not a crash — it is Riki saying a
 * true thing every forty-five seconds for the rest of the match, which no cooldown length fixes.
 */

import { describe, expect, it } from 'vitest';
import type { AbilityState, FieldPath, HeroId, MapPosition } from '@riki/world-model';
import { asMonoMs, fieldPath, heroField } from '@riki/world-model';
import { DEFAULT_TRIGGER_CONFIG as CFG, withTriggerConfig } from './config.js';
import { createEventEngine } from './engine.js';
import type { CoachEvent, SuppressionReason } from './types.js';
import { buildWorld } from './testing/index.js';
import { ultReady } from './detect/combat.js';

const META_PHASE: FieldPath = fieldPath('meta', 'phase');
const SELF_ALIVE: FieldPath = fieldPath('self', 'alive');
const SELF_ABILITIES: FieldPath = fieldPath('self', 'abilities');
const SF = 'sf' as HeroId;
const HERE: MapPosition = { x: 0, y: 0 };

function ult(castable: boolean): AbilityState {
  return { id: 'requiem', level: 3, cooldown: 0, castable, isUltimate: true } as AbilityState;
}

/** A world where exactly one detector — `ult_ready` — can fire, so the assertions are about gating. */
function ultWorld(castable = true) {
  return buildWorld()
    .put(META_PHASE, 'in_progress')
    .put(SELF_ALIVE, true)
    .put(SELF_ABILITIES, [ult(castable)])
    .put(heroField('enemies', SF, 'position'), HERE);
}

/**
 * The engine's clock and the world's are the same clock, deliberately: two readings inside one
 * decision is the shape of a bug that only shows up as an age disagreeing with itself.
 */
function engineOver(world: ReturnType<typeof ultWorld>) {
  const spoken: CoachEvent[] = [];
  const silent: SuppressionReason[] = [];

  const engine = createEventEngine({
    world: world.reader(),
    clock: { now: () => world.now },
    detectors: [ultReady],
  });
  engine.onCoachEvent((event) => spoken.push(event));
  engine.onSuppressed((reason) => silent.push(reason));

  return { engine, spoken, silent };
}

/** Long enough for every cooldown to expire, short enough that no latch does. */
const PAST_COOLDOWN_SECONDS = CFG.kindCooldownMs.ult_ready / 1000 + 1;

/**
 * Advance both clocks and re-observe the enemy.
 *
 * Worth its own function rather than an inline `advance`: `ult_ready` requires a *fresh* enemy
 * position, and a position expires at 20 s of game time — so a test that only advances is testing
 * that the sidecar went quiet, which is a different assertion than the one it means to make.
 */
function advance(world: ReturnType<typeof ultWorld>, seconds: number) {
  return world.advance(seconds).put(heroField('enemies', SF, 'position'), HERE);
}

describe('the engine speaks, once', () => {
  it('emits an admitted trigger with its topic and salience', () => {
    const world = ultWorld();
    const { engine, spoken } = engineOver(world);

    engine.evaluate(world.now);

    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.id).toBe('ult_ready');
    expect(spoken[0]?.topic).toEqual({ of: 'event', event: 'ult_ready' });
    expect(spoken[0]?.salience).toBeGreaterThanOrEqual(CFG.speakThreshold);
  });

  it('does not repeat while the condition stays true — the latch, not the cooldown', () => {
    const world = ultWorld();
    const { engine, spoken, silent } = engineOver(world);

    engine.evaluate(world.now);
    // Past every cooldown in the table, and short of the latch expiry. Only the latch is left.
    advance(world, PAST_COOLDOWN_SECONDS);
    engine.evaluate(world.now);

    expect(spoken).toHaveLength(1);
    expect(silent).toEqual(['latched']);
  });

  it('speaks again once the condition goes false and comes back', () => {
    const world = ultWorld();
    const { engine, spoken } = engineOver(world);

    engine.evaluate(world.now);

    world.put(SELF_ABILITIES, [ult(false)]);
    engine.evaluate(world.now); // condition false → the latch clears here

    advance(world, PAST_COOLDOWN_SECONDS).put(SELF_ABILITIES, [ult(true)]);
    engine.evaluate(world.now);

    expect(spoken).toHaveLength(2);
  });

  it('releases a latch that has been held past its game-time expiry', () => {
    const world = ultWorld();
    const { engine, spoken } = engineOver(world);

    engine.evaluate(world.now);
    advance(world, CFG.latchExpirySeconds + 1);
    engine.evaluate(world.now);

    expect(spoken).toHaveLength(2);
  });

  it('holds the kind cooldown even after the condition cycles', () => {
    const world = ultWorld();
    const { engine, spoken, silent } = engineOver(world);

    engine.evaluate(world.now);
    world.put(SELF_ABILITIES, [ult(false)]);
    engine.evaluate(world.now);
    world.put(SELF_ABILITIES, [ult(true)]);
    engine.evaluate(world.now);

    expect(spoken).toHaveLength(1);
    expect(silent.at(-1)).toBe('kind_cooldown');
  });
});

describe('the composition root’s four switches', () => {
  it('goes silent in quiet mode, and comes back when it is turned off', () => {
    const world = ultWorld();
    const { engine, spoken, silent } = engineOver(world);

    engine.setQuietMode(true);
    engine.evaluate(world.now);
    expect(spoken).toHaveLength(0);
    expect(silent).toEqual(['quiet_mode']);

    engine.setQuietMode(false);
    engine.evaluate(world.now);
    expect(spoken).toHaveLength(1);
  });

  it('drops a trigger while a turn is open, rather than queueing it', () => {
    const world = ultWorld();
    const { engine, spoken, silent } = engineOver(world);

    engine.setAgentSpeaking(true);
    engine.evaluate(world.now);
    engine.evaluate(world.now);

    expect(spoken).toHaveLength(0);
    expect(silent).toEqual(['agent_speaking', 'agent_speaking']);

    // And when the turn closes, the moment is not replayed from a queue — the world is re-read.
    engine.setAgentSpeaking(false);
    engine.evaluate(world.now);
    expect(spoken).toHaveLength(1);
  });

  it('honours a mute until it expires', () => {
    const world = ultWorld();
    const { engine, spoken } = engineOver(world);

    engine.setMuted(asMonoMs(world.now + 60_000));
    engine.evaluate(world.now);
    expect(spoken).toHaveLength(0);

    advance(world, 61);
    engine.evaluate(world.now);
    expect(spoken).toHaveLength(1);
  });

  it('never speaks over the player', () => {
    const world = ultWorld();
    const { engine, spoken } = engineOver(world);

    engine.setPlayerSpeaking(true);
    engine.evaluate(world.now);
    expect(spoken).toHaveLength(0);
  });
});

describe('suppression accounting', () => {
  it('counts every refusal under exactly one reason', () => {
    const world = ultWorld();
    const { engine } = engineOver(world);

    engine.setQuietMode(true);
    engine.evaluate(world.now);
    engine.evaluate(world.now);

    const counters = engine.counters();
    expect(counters.suppressed.quiet_mode).toBe(2);
    expect(Object.values(counters.suppressed).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('counts detections per kind, so an unwired detector is visible', () => {
    const world = ultWorld();
    const { engine } = engineOver(world);

    engine.evaluate(world.now);

    const counters = engine.counters();
    expect(counters.detected.ult_ready).toBe(1);
    // Nothing else was even given a chance, which is exactly what a zero means: unwired, not quiet.
    expect(counters.detected.enemy_missing).toBe(0);
    expect(counters.spoken).toBe(1);
  });

  it('does not count "nothing happened" as a suppression', () => {
    const world = ultWorld(false);
    const { engine, silent } = engineOver(world);

    engine.evaluate(world.now);

    expect(silent).toHaveLength(0);
    expect(Object.values(engine.counters().suppressed).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('the tape', () => {
  it('records a detection the gates refused', () => {
    const world = ultWorld();
    const { engine } = engineOver(world);

    engine.setQuietMode(true);
    engine.evaluate(world.now);

    expect(engine.tape.recent(5, null).map((e) => e.id)).toEqual(['ult_ready']);
  });

  it('records nothing outside a live match', () => {
    const world = ultWorld().put(META_PHASE, 'draft');
    const { engine } = engineOver(world);

    engine.evaluate(world.now);

    expect(engine.tape.recent(5, null)).toHaveLength(0);
  });
});

describe('the subscription', () => {
  it('runs a tick on every version bump and stops on unsubscribe', () => {
    const world = ultWorld();
    const { engine, spoken } = engineOver(world);

    const stop = engine.start();
    world.commit();
    expect(spoken).toHaveLength(1);

    stop();
    world.put(SELF_ABILITIES, [ult(false)]);
    world.commit();
    world.put(SELF_ABILITIES, [ult(true)]);
    world.commit();
    expect(spoken).toHaveLength(1);
  });

  it('survives a detector that throws, and says so by leaving its counter at zero', () => {
    const world = ultWorld();
    const spoken: CoachEvent[] = [];
    const engine = createEventEngine({
      world: world.reader(),
      clock: { now: () => world.now },
      detectors: [
        {
          kind: 'enemy_missing',
          detect: () => {
            throw new Error('detector bug');
          },
        },
        ultReady,
      ],
    });
    engine.onCoachEvent((event) => spoken.push(event));

    expect(() => engine.evaluate(world.now)).not.toThrow();
    expect(spoken).toHaveLength(1);
    expect(engine.counters().detected.enemy_missing).toBe(0);
  });

  it('forgets everything on dispose', () => {
    const world = ultWorld();
    const { engine, spoken } = engineOver(world);

    engine.start();
    world.commit();
    engine.dispose();
    world.put(SELF_ABILITIES, [ult(false)]);
    world.commit();

    expect(spoken).toHaveLength(1);
    expect(engine.counters().spoken).toBe(0);
  });
});

describe('config is the only lever', () => {
  it('a lower threshold admits what a higher one refused', () => {
    const world = ultWorld();
    const spoken: CoachEvent[] = [];
    const engine = createEventEngine({
      world: world.reader(),
      clock: { now: () => world.now },
      detectors: [ultReady],
      config: withTriggerConfig({ speakThreshold: 1 }),
    });
    engine.onCoachEvent((event) => spoken.push(event));

    engine.evaluate(world.now);
    expect(spoken).toHaveLength(0);
    expect(engine.counters().suppressed.below_threshold).toBe(1);
  });
});

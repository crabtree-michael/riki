/**
 * Tier 1. §10's shape exactly: construct a state, apply an observation, assert the next state.
 * No fixtures, no clock, no listener — which is the whole return on ADR-0014's purity.
 */

import { describe, expect, it } from 'vitest';
import { asConfidence } from '../fact.js';
import type { HeroId } from '../state.js';
import { emptyState, fieldPath, readFact } from '../state.js';
import { cvPayload, detection, gsiPayload, observation } from '../testing/index.js';
import { asMonoMs } from '../time.js';
import { createConfidenceGate } from './confidence.js';
import { createPrecedencePolicy } from './precedence.js';
import type { FusionPolicies } from './reducer.js';
import { fuse } from './reducer.js';
import { createStalenessPolicy } from './staleness.js';

const policies: FusionPolicies = {
  precedence: createPrecedencePolicy(),
  confidence: createConfidenceGate(),
  staleness: createStalenessPolicy(),
};

const base = () => emptyState(asMonoMs(0));

describe('GSI payloads', () => {
  it('lands self state and stamps it with the match clock, not with `now`', () => {
    const state = base();
    const o = observation(
      'gsi.payload',
      gsiPayload({
        hero: { name: 'npc_dota_hero_riki', level: 11, health: 840, max_health: 1000, alive: true },
      }),
      { receivedAt: 5_000 },
    );

    const { state: next } = fuse(state, o, asMonoMs(5_010), policies);
    const health = readFact(next, fieldPath('self', 'health'));

    expect(health?.value).toEqual({ current: 840, max: 1000 });
    expect(health?.source).toBe('gsi');
    // Stamped at receipt (5000), not at processing (5010): the fact was observed when the POST
    // arrived, and the ten milliseconds of our own processing are not part of its age.
    expect(health?.observedAt).toBe(5_000);
    expect(health?.atGameClock).toBe(600);
  });

  it('treats an absent component as unchanged rather than as cleared', () => {
    // The single most expensive GSI parsing mistake there is: a POST carrying only `map` would
    // wipe the hero if absence meant absent.
    const first = fuse(
      base(),
      observation('gsi.payload', gsiPayload({ hero: { name: 'npc_dota_hero_riki', level: 11 } })),
      asMonoMs(0),
      policies,
    ).state;

    const second = fuse(
      first,
      observation('gsi.payload', gsiPayload(), { receivedAt: 1_000 }),
      asMonoMs(1_000),
      policies,
    ).state;

    expect(readFact(second, fieldPath('self', 'level'))?.value).toBe(11);
  });

  it('does not throw on a component Valve added since this build', () => {
    // A strict parser turns a patch day into a total outage; this one ignores what it does not
    // know and keeps everything it does.
    const o = observation(
      'gsi.payload',
      gsiPayload({
        couriers: { courier0: { health: 100 } },
        some_new_component_2027: { anything: true },
        hero: { name: 'npc_dota_hero_riki', level: 4 },
      }),
    );

    const { state: next, rejections } = fuse(base(), o, asMonoMs(0), policies);
    expect(readFact(next, fieldPath('self', 'level'))?.value).toBe(4);
    expect(rejections).toEqual([]);
  });

  it('returns the input state, referentially, when nothing changed', () => {
    // §5.2 promises this and the store relies on it to decide whether to bump the version.
    const state = base();
    const empty = observation('gsi.payload', {});
    expect(fuse(state, empty, asMonoMs(0), policies).state).toBe(state);
  });

  it('keeps a negative pre-horn clock rather than reading it as missing', () => {
    const o = observation(
      'gsi.payload',
      gsiPayload({
        map: { game_state: 'DOTA_GAMERULES_STATE_PRE_GAME', clock_time: -45, paused: false },
      }),
    );
    const { state: next } = fuse(base(), o, asMonoMs(0), policies);
    expect(readFact(next, fieldPath('meta', 'clock'))?.value).toBe(-45);
    expect(readFact(next, fieldPath('meta', 'phase'))?.value).toBe('pre_game');
  });
});

describe('CV detections', () => {
  const sf = 'npc_dota_hero_nevermore' as HeroId;

  it('creates the enemy entry and writes position and lastSeenAt together', () => {
    const o = observation(
      'cv.detections',
      cvPayload([detection({ kind: 'hero_position', side: 'enemies', hero: sf, x: 100, y: 200 })]),
    );

    const { state: next } = fuse(base(), o, asMonoMs(0), policies);
    const enemy = next.enemies.get(sf);

    expect(enemy?.position?.value).toEqual({ x: 100, y: 200 });
    // Written by the same step, which is what lets position expire into it with no timer.
    expect(enemy?.lastSeenAt?.value).toEqual({ x: 100, y: 200 });
    // The synthesised roster entry inherits CV provenance: it was CV that named this hero.
    expect(enemy?.hero.source).toBe('cv');
  });

  it('drops a below-threshold detection instead of admitting it hedged', () => {
    const gate = createConfidenceGate(new Map(), asConfidence(0.7));
    const o = observation(
      'cv.detections',
      cvPayload([
        detection({
          kind: 'hero_position',
          side: 'enemies',
          hero: sf,
          x: 1,
          y: 2,
          confidence: 0.4,
        }),
      ]),
    );

    const { state: next, rejections } = fuse(base(), o, asMonoMs(0), {
      ...policies,
      confidence: gate,
    });

    expect(next.enemies.size).toBe(0);
    expect(rejections.map((r) => r.why)).toContain('below_threshold');
  });

  it('rejects a confidence outside 0–1 rather than clamping it to certainty', () => {
    const o = observation(
      'cv.detections',
      cvPayload([
        detection({
          kind: 'hero_position',
          side: 'enemies',
          hero: sf,
          x: 1,
          y: 2,
          confidence: 1.4,
        }),
      ]),
    );

    const { state: next, rejections } = fuse(base(), o, asMonoMs(0), policies);
    expect(next.enemies.size).toBe(0);
    expect(rejections).toHaveLength(1);
  });

  it('ages a detection from its own capture time, not from when the batch arrived', () => {
    // The batch is later than every region in it by however long CV took. Ageing from arrival
    // makes every position look fresher than it is, in the direction that gets someone killed.
    const o = observation(
      'cv.detections',
      cvPayload([
        detection({
          kind: 'hero_position',
          side: 'enemies',
          hero: sf,
          x: 1,
          y: 2,
          observedAt: 900,
        }),
      ]),
      { receivedAt: 1_000 },
    );

    const { state: next } = fuse(base(), o, asMonoMs(1_000), policies);
    expect(next.enemies.get(sf)?.position?.observedAt).toBe(900);
  });

  it('never lets CV reach self state, however quiet GSI has been', () => {
    const o = observation(
      'cv.detections',
      cvPayload([detection({ kind: 'hero_level', side: 'allies', hero: 'self', level: 9 })]),
    );
    const { state: next } = fuse(base(), o, asMonoMs(600_000), policies);
    expect(readFact(next, fieldPath('self', 'level'))).toBeUndefined();
  });
});

describe('log events', () => {
  const sf = 'npc_dota_hero_nevermore' as HeroId;

  it('marks a known enemy dead from the kill feed', () => {
    const seeded = fuse(
      base(),
      observation(
        'cv.detections',
        cvPayload([detection({ kind: 'hero_position', side: 'enemies', hero: sf, x: 1, y: 2 })]),
      ),
      asMonoMs(0),
      policies,
    ).state;

    const { state: next } = fuse(
      seeded,
      observation('log.event', { kind: 'kill', victim: sf, killer: 'npc_dota_hero_riki' }),
      asMonoMs(0),
      policies,
    );

    expect(next.enemies.get(sf)?.alive?.value).toBe(false);
    expect(next.enemies.get(sf)?.alive?.source).toBe('log');
  });

  it('ignores a kill involving a hero the model has never heard of', () => {
    // The kill feed gives two names and no teams; which side someone is on is the model's
    // knowledge, and guessing it would put a stranger in the enemy list.
    const { state: next } = fuse(
      base(),
      observation('log.event', { kind: 'kill', victim: 'npc_dota_hero_pudge' }),
      asMonoMs(0),
      policies,
    );
    expect(next.enemies.size).toBe(0);
    expect(next.allies.size).toBe(0);
  });

  it('puts a chat line in the ring and bumps state identity so events can see it', () => {
    const state = base();
    const { state: next } = fuse(
      state,
      observation('log.event', { kind: 'chat', text: 'gg', channel: 'all', speaker: 'someone' }),
      asMonoMs(0),
      policies,
    );

    expect(next).not.toBe(state);
    expect(next.chat.last(1)[0]?.text).toBe('gg');
    // Privacy is applied at the source and travels with the line (§4.2).
    expect(next.chat.last(1)[0]?.privacy).toBe('sensitive');
  });
});

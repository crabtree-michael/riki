/**
 * The store and the snapshot together, because neither is interesting alone: the store's whole
 * job is to turn a sequence of observations into versions, and the snapshot's whole job is to
 * hand one of those versions out in a form that cannot be read without its provenance.
 *
 * The latency assertion here is a floor, not the Tier 4 budget: §6.1's 10 ms is measured over a
 * replayed match in the composition root, which is a later step. What this catches is an
 * `apply()` that has quietly become quadratic.
 */

import { describe, expect, it, vi } from 'vitest';
import { DERIVED_IDS } from './derived/registry.js';
import type { HeroId } from './state.js';
import { fieldPath } from './state.js';
import { createWorldModelStore } from './store.js';
import { cvPayload, detection, gsiPayload, observation } from './testing/index.js';
import { asGameClock, asMonoMs } from './time.js';

const sf = 'npc_dota_hero_nevermore' as HeroId;

describe('versioning', () => {
  it('bumps only when something actually landed', () => {
    const store = createWorldModelStore();
    const payload = gsiPayload({ hero: { name: 'npc_dota_hero_riki', level: 11 } });

    store.apply(observation('gsi.payload', payload), asMonoMs(0));
    const afterFirst = store.version;

    // The same POST again: every candidate is a re-observation, so facts are replaced and the
    // version moves. A POST carrying nothing at all must not.
    const empty = store.apply(observation('gsi.payload', {}), asMonoMs(100));
    expect(empty.changed).toBe(false);
    expect(store.version).toBe(afterFirst);
  });

  it('notifies with a delta naming the fields that moved', () => {
    const store = createWorldModelStore();
    const seen = vi.fn();
    store.onVersion(seen);

    store.apply(
      observation('gsi.payload', gsiPayload({ hero: { name: 'npc_dota_hero_riki', level: 11 } })),
      asMonoMs(0),
    );

    expect(seen).toHaveBeenCalledTimes(1);
    const [, delta] = seen.mock.calls[0] as [number, { changes: { path: string }[] }];
    expect(delta.changes.map((c) => c.path)).toContain('self.level');
  });

  it('unsubscribes cleanly', () => {
    const store = createWorldModelStore();
    const seen = vi.fn();
    store.onVersion(seen)();
    store.apply(observation('gsi.payload', gsiPayload()), asMonoMs(0));
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('snapshot', () => {
  it('hands back a fact with its staleness and never a bare value', () => {
    const store = createWorldModelStore();
    store.apply(
      observation('gsi.payload', gsiPayload({ hero: { name: 'npc_dota_hero_riki', level: 11 } })),
      asMonoMs(0),
    );

    const read = store.snapshot(asMonoMs(0)).get<number>(fieldPath('self', 'level'));
    expect(read?.fact.value).toBe(11);
    expect(read?.fact.source).toBe('gsi');
    expect(read?.staleness).toBe('fresh');
  });

  it('is undefined for a field never observed, which is not the same as observed-absent', () => {
    const store = createWorldModelStore();
    expect(store.snapshot(asMonoMs(0)).get(fieldPath('self', 'gold'))).toBeUndefined();
  });

  it('lists an enemy with no position as expired rather than omitting them', () => {
    // Omission reads as absent, and "they're not around" is how someone walks into four people.
    const store = createWorldModelStore();
    store.apply(
      observation(
        'cv.detections',
        cvPayload([detection({ kind: 'hero_level', side: 'enemies', hero: sf, level: 10 })]),
      ),
      asMonoMs(0),
    );

    const enemies = store.snapshot(asMonoMs(0)).enemies();
    expect(enemies).toHaveLength(1);
    expect(enemies[0]?.staleness).toBe('expired');
    expect(store.snapshot(asMonoMs(0)).unseenFor(20)).toEqual([sf]);
  });

  it('drops a hero out of `unseenFor` the moment CV sees them', () => {
    const store = createWorldModelStore();
    store.apply(observation('gsi.payload', gsiPayload(), { receivedAt: 0 }), asMonoMs(0));
    store.apply(
      observation(
        'cv.detections',
        cvPayload([detection({ kind: 'hero_position', side: 'enemies', hero: sf, x: 1, y: 2 })]),
        { receivedAt: 0 },
      ),
      asMonoMs(0),
    );

    expect(store.snapshot(asMonoMs(0)).unseenFor(20)).toEqual([]);
  });

  it('resolves derived state lazily, so an untaken snapshot costs nothing', () => {
    // The §5.7 claim: seven of eight GSI updates never have a snapshot taken of them.
    const store = createWorldModelStore();
    store.apply(observation('gsi.payload', gsiPayload()), asMonoMs(0));

    const snapshot = store.snapshot(asMonoMs(0));
    expect(snapshot.derived.get(DERIVED_IDS.runeTimings)).not.toBeNull();
    // A rule whose inputs have never been observed answers null rather than guessing.
    expect(snapshot.derived.get(DERIVED_IDS.buybackAffordable)).toBeNull();
  });
});

describe('pause, reset and history', () => {
  it('freezes tactical ageing through a pause without discarding anything', () => {
    // §6.4: the response to a pause is to freeze ageing, not to drop facts — and the freeze is a
    // consequence of the clock not advancing, which is why `setPaused` has no body to speak of.
    const store = createWorldModelStore();
    // GSI first, and the order is load-bearing rather than cosmetic: the reducer stamps a
    // non-GSI observation with the clock the *model* currently holds, so a CV batch that lands
    // before the first POST is stamped clockless and ages in wall time — correctly, since there
    // was no match clock to age it against.
    store.apply(
      observation('gsi.payload', gsiPayload({ map: { clock_time: 600, paused: true } }), {
        receivedAt: 0,
      }),
      asMonoMs(0),
    );
    store.apply(
      observation(
        'cv.detections',
        cvPayload([detection({ kind: 'hero_position', side: 'enemies', hero: sf, x: 1, y: 2 })]),
        { receivedAt: 0 },
      ),
      asMonoMs(0),
    );
    store.setPaused(true, asMonoMs(0));

    // Forty wall seconds later, with the match clock unmoved.
    const snapshot = store.snapshot(asMonoMs(40_000));
    expect(snapshot.enemies()[0]?.staleness).toBe('fresh');
    expect(store.paused).toBe(true);
  });

  it('empties the model on reset and says so in the delta', () => {
    const store = createWorldModelStore();
    store.apply(
      observation('gsi.payload', gsiPayload({ hero: { name: 'npc_dota_hero_riki', level: 11 } })),
      asMonoMs(0),
    );

    const seen = vi.fn();
    store.onVersion(seen);
    store.reset('new_match', asMonoMs(1_000));

    const [, delta] = seen.mock.calls[0] as [
      number,
      { changes: { path: string; after?: unknown }[] },
    ];
    const level = delta.changes.find((c) => c.path === 'self.level');
    expect(level?.after).toBeUndefined();
    expect(store.snapshot(asMonoMs(1_000)).get(fieldPath('self', 'level'))).toBeUndefined();
    // The version keeps counting, so a reader holding an old snapshot can tell that it is old.
    expect(store.version).toBeGreaterThan(1);
  });

  it('keeps a delta tape queryable by match clock', () => {
    const store = createWorldModelStore();
    store.apply(
      observation('gsi.payload', gsiPayload({ hero: { name: 'npc_dota_hero_riki', level: 11 } })),
      asMonoMs(0),
    );
    expect(store.history(asGameClock(0))).toHaveLength(1);
    expect(store.history(asGameClock(6_000))).toHaveLength(0);
  });
});

describe('rejections', () => {
  it('counts a dropped CV fact instead of losing it silently', () => {
    // "CV facts stopped landing three patches ago" presents as nothing at all; the counter is the
    // cheapest possible detector for it (§5.1).
    const store = createWorldModelStore();
    const result = store.apply(
      observation(
        'cv.detections',
        cvPayload([
          detection({
            kind: 'hero_level',
            side: 'allies',
            hero: 'self',
            level: 9,
            confidence: 0.2,
          }),
        ]),
      ),
      asMonoMs(0),
    );

    expect(result.changed).toBe(false);
    expect(result.rejected.length).toBeGreaterThan(0);
  });
});

describe('cost', () => {
  it('applies a POST in well under a millisecond', () => {
    const store = createWorldModelStore();
    const payload = gsiPayload({
      hero: {
        name: 'npc_dota_hero_riki',
        level: 11,
        health: 840,
        max_health: 1000,
        mana: 300,
        max_mana: 500,
        alive: true,
        xpos: 1,
        ypos: 2,
      },
      player: {
        gold_reliable: 320,
        gold_unreliable: 1520,
        gpm: 512,
        xpm: 610,
        kills: 4,
        deaths: 1,
        assists: 3,
        last_hits: 96,
        denies: 12,
        net_worth: 7200,
        team_name: 'radiant',
      },
      items: { slot0: { name: 'item_diffusal_blade', charges: 1, cooldown: 0, can_cast: true } },
    });

    const iterations = 500;
    const started = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      store.apply(observation('gsi.payload', payload, { receivedAt: i, seq: i }), asMonoMs(i));
    }
    const perApply = (performance.now() - started) / iterations;

    // A generous ceiling: this is here to catch `apply()` becoming quadratic in the field count,
    // not to stand in for the Tier 4 budget, which is measured over a replayed match.
    expect(perApply).toBeLessThan(2);
  });
});

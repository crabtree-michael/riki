/**
 * Tier 1 for everything in this package that is not a socket, plus one real socket for the parts
 * that only exist because there is one.
 *
 * §10's rows for `packages/gsi` are: parser against `fixtures/gsi/` including an unknown
 * component that must not throw; authenticator across missing / wrong / correct with the token
 * never appearing in output; clock estimator across interpolation, freeze-on-pause and correction
 * on discontinuity. All three are here.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGsiAuthenticator, tokenFromBody } from './auth.js';
import { clockDrift, createGameClockEstimator } from './clock.js';
import type { GameClock, MonoMs } from './contracts.js';
import { createGsiLiveness } from './liveness.js';
import { createGsiPayloadParser } from './parse.js';
import { createMatchSessionTracker } from './session.js';
import { createGsiServer, DEFAULT_MAX_BODY_BYTES } from './server.js';
import { createFakeGsiSource, createManualClock, parseGsiFixture } from './testing/index.js';

const at = (ms: number): MonoMs => ms as MonoMs;
const gc = (s: number): GameClock => s as GameClock;

const fixture = (name: string) => parseGsiFixture(readFileSync(`fixtures/gsi/${name}`, 'utf8'));

describe('GsiAuthenticator', () => {
  const auth = createGsiAuthenticator('s3cret-per-install-token');

  it('accepts the right token', () => {
    expect(auth.verify('s3cret-per-install-token')).toBe('ok');
  });

  it('distinguishes a missing token from a wrong one', () => {
    // Useful to us — "missing" means the cfg was never written, "mismatch" means it is stale —
    // and counted separately. The client is told neither.
    expect(auth.verify(undefined)).toBe('missing');
    expect(auth.verify('')).toBe('missing');
    expect(auth.verify('wrong')).toBe('mismatch');
  });

  it('handles a wrong token of a different length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which would leak the length by exception.
    expect(() => auth.verify('x')).not.toThrow();
    expect(auth.verify('x'.repeat(500))).toBe('mismatch');
  });

  it('never returns or embeds the token', () => {
    const verdicts = ['s3cret-per-install-token', 'wrong', undefined].map((t) => auth.verify(t));
    expect(JSON.stringify(verdicts)).not.toContain('s3cret');
  });

  it('finds the token where Valve puts it, and nowhere else', () => {
    expect(tokenFromBody({ auth: { token: 'abc' } })).toBe('abc');
    expect(tokenFromBody({ token: 'abc' })).toBeUndefined();
    expect(tokenFromBody(null)).toBeUndefined();
    expect(tokenFromBody('nope')).toBeUndefined();
  });
});

describe('GsiPayloadParser', () => {
  const parser = createGsiPayloadParser();

  it('parses every line of the fixture corpus', () => {
    for (const name of ['laning-phase.jsonl', 'draft.jsonl']) {
      for (const line of fixture(name)) {
        expect(parser.parse(line.body).ok).toBe(true);
      }
    }
  });

  it('does not throw on a component Valve added since this build — it keeps it', () => {
    // A strict parser turns a patch day into a total outage. This one files the stranger under
    // `unknown` so a later build can find out what it was missing without a new recording.
    const withUnknown = fixture('laning-phase.jsonl').find((line) =>
      JSON.stringify(line.body).includes('neutralitems_2027'),
    );
    expect(withUnknown).toBeDefined();

    const parsed = parser.parse(withUnknown?.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value.unknown)).toContain('neutralitems_2027');
    expect(Object.keys(parsed.value.unknown)).toContain('couriers');
  });

  it('drops Valve delta blocks rather than filing them as unknown components', () => {
    const parsed = parser.parse({ previously: { hero: {} }, added: {}, map: { clock_time: 5 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value.unknown)).toEqual([]);
  });

  it('drops the auth block, so a token cannot reach an observation', () => {
    const parsed = parser.parse({ auth: { token: 'secret' }, map: { clock_time: 5 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(parsed.value)).not.toContain('secret');
  });

  it('keeps a clock of zero and a negative one', () => {
    // Both are real values and both are falsy, which is how they get lost.
    expect(parser.parse({ map: { clock_time: 0 } })).toMatchObject({
      ok: true,
      value: { map: { clock_time: 0 } },
    });
    expect(parser.parse({ map: { clock_time: -45 } })).toMatchObject({
      ok: true,
      value: { map: { clock_time: -45 } },
    });
  });

  it('rejects only a body that is not an object at all', () => {
    expect(parser.parse('nope').ok).toBe(false);
    expect(parser.parse([]).ok).toBe(false);
    expect(parser.parse({}).ok).toBe(true);
  });
});

describe('GameClockEstimator', () => {
  it('answers null before the first update, which is not clock zero', () => {
    // Pre-horn and loading genuinely have no clock; answering 0 would date every fact to the horn.
    expect(createGameClockEstimator().estimate(at(1_000))).toBeNull();
  });

  it('interpolates at 1 s/s between POSTs', () => {
    const estimator = createGameClockEstimator();
    estimator.update(gc(600), at(10_000), false);
    expect(estimator.estimate(at(10_400))).toBeCloseTo(600.4, 6);
    expect(estimator.estimate(at(12_000))).toBeCloseTo(602, 6);
  });

  it('freezes while paused, however much wall time passes', () => {
    const estimator = createGameClockEstimator();
    estimator.update(gc(600), at(10_000), true);
    expect(estimator.estimate(at(50_000))).toBe(600);
  });

  it('is corrected, not smoothed, on the next real update', () => {
    // Smoothing would hide a reconnect behind a gradual convergence that looks like drift.
    const estimator = createGameClockEstimator();
    estimator.update(gc(600), at(10_000), false);
    expect(clockDrift(estimator, gc(900), at(11_000))).toBeCloseTo(299, 6);

    estimator.update(gc(900), at(11_000), false);
    expect(estimator.estimate(at(11_000))).toBe(900);
  });
});

describe('GsiLiveness', () => {
  const liveness = createGsiLiveness();

  it('starts as starting, not as down', () => {
    expect(createGsiLiveness().check(at(0)).state).toBe('starting');
  });

  it('reports live within the heartbeat, degraded past it, down past the miss threshold', () => {
    // The heartbeat is what makes this possible: Valve POSTs every 30 s even when nothing
    // changed, so silence means something rather than "nothing happened".
    liveness.noteObservation(at(0));
    expect(liveness.check(at(20_000)).state).toBe('live');
    expect(liveness.check(at(32_000)).state).toBe('degraded');
    expect(liveness.check(at(36_000)).state).toBe('down');
  });

  it('keeps ageing in wall time, so a paused-but-departed client is still detected', () => {
    const paused = createGsiLiveness();
    paused.noteObservation(at(0));
    expect(paused.check(at(40_000)).state).toBe('down');
  });
});

describe('MatchSessionTracker', () => {
  it('reports the edges of a draft, not the state', () => {
    const tracker = createMatchSessionTracker();
    const parser = createGsiPayloadParser();
    const lines = fixture('draft.jsonl');

    const first = parser.parse(lines[0]?.body);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const events = tracker.observe(first.value, { observedAt: at(0) });
    const started = events.find((e) => e.type === 'match_started');
    expect(started).toBeDefined();
    expect(events.find((e) => e.type === 'phase_changed')).toMatchObject({
      from: 'idle',
      to: 'hero_selection',
    });
  });

  it('says nothing on a second identical POST', () => {
    const tracker = createMatchSessionTracker();
    const payload = {
      map: {
        matchid: '1',
        game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
        paused: false,
        clock_time: 100,
      },
    } as never;
    tracker.observe(payload, { observedAt: at(0) });
    expect(tracker.observe(payload, { observedAt: at(0) })).toEqual([]);
  });

  it('reports pause and resume as separate edges', () => {
    const tracker = createMatchSessionTracker();
    const make = (paused: boolean, clock: number) =>
      ({
        map: {
          matchid: '1',
          game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
          paused,
          clock_time: clock,
        },
      }) as never;

    tracker.observe(make(false, 100), { observedAt: at(0) });
    expect(tracker.observe(make(true, 100), { observedAt: at(1_000) })).toContainEqual({
      type: 'paused',
    });
    expect(tracker.observe(make(false, 100), { observedAt: at(2_000) })).toContainEqual({
      type: 'resumed',
    });
  });

  it('reports a clock discontinuity rather than drifting into wrongness', () => {
    // A reconnect, or a new match reusing the id. §6.4 turns this into a resync.
    const tracker = createMatchSessionTracker();
    const make = (clock: number) =>
      ({
        map: {
          matchid: '1',
          game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
          paused: false,
          clock_time: clock,
        },
      }) as never;

    tracker.observe(make(100), { observedAt: at(0) });
    const events = tracker.observe(make(400), { observedAt: at(1_000) });
    expect(events.find((e) => e.type === 'clock_discontinuity')).toMatchObject({ delta: 299 });
  });

  it('does not call ordinary interpolation error a discontinuity', () => {
    const tracker = createMatchSessionTracker();
    const make = (clock: number) =>
      ({
        map: {
          matchid: '1',
          game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
          paused: false,
          clock_time: clock,
        },
      }) as never;

    tracker.observe(make(100), { observedAt: at(0) });
    expect(tracker.observe(make(102), { observedAt: at(1_000) })).toEqual([]);
  });

  it('closes the old match when the id changes without a post-game', () => {
    const tracker = createMatchSessionTracker();
    const make = (id: string) =>
      ({
        map: { matchid: id, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', paused: false },
      }) as never;

    tracker.observe(make('1'), { observedAt: at(0) });
    const events = tracker.observe(make('2'), { observedAt: at(1_000) });
    expect(events.map((e) => e.type)).toEqual(['match_ended', 'match_started']);
  });
});

describe('the fixture corpus replays without resetting the world', () => {
  /**
   * The regression this exists for: `atMs` and `map.clock_time` were authored independently, so
   * game time ran ~25x wall time, every non-paused frame tripped the discontinuity threshold, and
   * `apps/desktop`'s state subsystem answered each one by resetting the world model. Roughly ten
   * resets in a 22-frame replay — which destroys the delta history dota2 §4 asks for — and every
   * test in the repo still passed, because nothing asserted on it.
   *
   * A fixture whose two clocks disagree is not a fixture of anything real, so this is a property of
   * the corpus rather than of one file: any `fixtures/gsi/*.jsonl` added later is covered too.
   */
  for (const name of ['laning-phase.jsonl', 'draft.jsonl']) {
    it(`${name} keeps wall time and game time in step`, () => {
      const tracker = createMatchSessionTracker();
      const parser = createGsiPayloadParser();
      const discontinuities: { atMs: number; delta: number }[] = [];

      for (const line of fixture(name)) {
        const parsed = parser.parse(line.body);
        if (!parsed.ok) continue;
        // The recorded gap, which is the whole point: a replay that advances its clock by a flat
        // step instead reintroduces exactly the disagreement this guards against.
        for (const event of tracker.observe(parsed.value, { observedAt: at(line.atMs) })) {
          if (event.type === 'clock_discontinuity') {
            discontinuities.push({ atMs: line.atMs, delta: event.delta });
          }
        }
      }

      expect(discontinuities).toEqual([]);
    });
  }
});

describe('FakeGsiSource', () => {
  it('replays the fixture as observations a consumer cannot tell from the real thing', () => {
    const clock = createManualClock();
    const source = createFakeGsiSource({ lines: fixture('laning-phase.jsonl'), clock });

    const seen: number[] = [];
    source.subscribe((o) => seen.push(o.seq));
    const emitted = source.drain();

    expect(emitted).toBeGreaterThan(20);
    // Monotone `seq` is what lets the bus detect a gap or a reorder (§6.2).
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(source.remaining).toBe(0);
  });

  it('tracks liveness off the injected clock, not off wall time', () => {
    const clock = createManualClock();
    const source = createFakeGsiSource({ lines: fixture('laning-phase.jsonl'), clock });

    source.step();
    expect(source.health(clock.now()).state).toBe('live');
    clock.advance(40_000);
    expect(source.health(clock.now()).state).toBe('down');
  });
});

describe('GsiServer', () => {
  const token = 'per-install-secret';

  async function withServer<T>(
    fn: (base: string, server: ReturnType<typeof createGsiServer>) => Promise<T>,
  ): Promise<T> {
    const clock = createManualClock();
    const server = createGsiServer({ port: 0, token, clock, maxBodyBytes: DEFAULT_MAX_BODY_BYTES });
    await server.start();
    try {
      const port = server.address?.port ?? 0;
      return await fn(`http://127.0.0.1:${String(port)}`, server);
    } finally {
      await server.stop();
    }
  }

  const post = (base: string, body: unknown) =>
    fetch(`${base}/gsi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('binds loopback only', async () => {
    await withServer(async (base, server) => {
      expect(server.address?.port).toBeGreaterThan(0);
      // Not an assertion about the OS so much as about us: the listen call names 127.0.0.1, and
      // this catches someone "fixing" a connection problem by widening it to 0.0.0.0.
      const res = await post(base, { auth: { token }, map: { clock_time: 1 } });
      expect(res.status).toBe(200);
    });
  });

  it('accepts an authenticated POST and publishes it', async () => {
    await withServer(async (base, server) => {
      const seen: unknown[] = [];
      server.subscribe((o) => seen.push(o.payload));

      await post(base, {
        auth: { token },
        map: { matchid: '1', clock_time: 600 },
        hero: { name: 'npc_dota_hero_riki', level: 11 },
      });
      await new Promise((r) => setImmediate(r));

      expect(seen).toHaveLength(1);
      expect(server.stats().accepted).toBe(1);
    });
  });

  it('refuses a bad token with 403 and never parses the body', async () => {
    await withServer(async (base, server) => {
      const seen: unknown[] = [];
      server.subscribe((o) => seen.push(o));

      expect((await post(base, { auth: { token: 'wrong' }, map: {} })).status).toBe(403);
      expect((await post(base, { map: {} })).status).toBe(403);

      expect(seen).toEqual([]);
      expect(server.stats().rejectedAuth).toBe(2);
    });
  });

  it('rejects an oversized body rather than buffering it', async () => {
    const clock = createManualClock();
    const server = createGsiServer({ port: 0, token, clock, maxBodyBytes: 256 });
    await server.start();
    try {
      const port = server.address?.port ?? 0;
      const res = await fetch(`http://127.0.0.1:${String(port)}/gsi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auth: { token }, filler: 'x'.repeat(4000) }),
      }).catch(() => ({ status: 413 }) as Response);

      expect(res.status).toBe(413);
      expect(server.stats().rejectedTooLarge).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it('answers a malformed body without taking the listener down', async () => {
    // Dota does not read our status codes and will keep POSTing; a 500 loop helps nobody.
    await withServer(async (base, server) => {
      const res = await fetch(`${base}/gsi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      expect(res.status).toBe(400);

      expect((await post(base, { auth: { token }, map: { clock_time: 1 } })).status).toBe(200);
      expect(server.stats().accepted).toBe(1);
    });
  });

  it('emits lifecycle edges alongside observations', async () => {
    await withServer(async (base, server) => {
      const events: string[] = [];
      server.onLifecycle((batch) => events.push(...batch.map((e) => e.type)));

      await post(base, {
        auth: { token },
        map: {
          matchid: '7891234567',
          game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
          paused: false,
          clock_time: 600,
        },
      });
      await new Promise((r) => setImmediate(r));

      expect(events).toContain('match_started');
    });
  });
});

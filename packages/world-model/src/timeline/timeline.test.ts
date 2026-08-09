/**
 * T6's promise, asserted where it is made.
 *
 * The ticket's "done when" is one sentence and it is the first `describe` below: *reading a
 * recorded fixture at N instants reconstructs exactly what the live store held at those versions,
 * asserted field by field*. Everything else here defends a property that sentence assumes —
 * that the work is bounded, that the two axes mean what they say, and that a question the
 * recording cannot answer comes back as a sentence rather than as a plausible number.
 *
 * The recording under test is produced the way a real one is: a real `WorldModelStore` and a real
 * `MatchRecorder`, driven by the real GSI POSTs in `fixtures/gsi/laning-phase.jsonl`. That fixture
 * is read as raw JSON rather than through `@riki/gsi`, which this package may not import
 * (ADR-0014) and does not need to — `body` is the POST, and `fuse` parses it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLS, UNKNOWN_REASONS, isUnknown, type ToolResultFor } from '@riki/protocol';

import type { Fact } from '../fact.js';
import type { FieldPath, HeroId, WorldState } from '../state.js';
import { DEFAULT_HISTORY_WINDOW_SECONDS, fieldPath, flattenFacts } from '../state.js';
import { createWorldModelStore } from '../store.js';
import { asGameClock, asMonoMs } from '../time.js';
import type { MonoMs } from '../time.js';
import { gsiPayload, observation } from '../testing/index.js';
import type { RecordSink } from '../record/recorder.js';
import { createMatchRecorder } from '../record/recorder.js';
import type { ToolContext } from '../tools/context.js';
import type { WorldAtProjections } from './world-at.js';
import { answerWorldAt } from './world-at.js';
import { openTimeline } from './reader.js';
import { economy, enemy, myState, objectives } from '../tools/index.js';

// -------------------------------------------------------------------------------------------
// A recording, made the way the app makes one
// -------------------------------------------------------------------------------------------

const FIXTURE = fileURLToPath(
  new URL('../../../../fixtures/gsi/laning-phase.jsonl', import.meta.url),
);

interface FixturePost {
  readonly atMs: number;
  readonly body: unknown;
}

function fixturePosts(): readonly FixturePost[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
    .map((line) => JSON.parse(line) as FixturePost);
}

/** What the live store held after one POST — the thing a reconstruction has to reproduce. */
interface LiveMoment {
  readonly atMs: number;
  readonly clock: number | null;
  readonly version: number;
  readonly lastUpdatedAt: MonoMs;
  readonly facts: ReadonlyMap<FieldPath, Fact<unknown>>;
  /**
   * The four tools, run **at this instant** rather than later against a kept snapshot.
   *
   * That distinction is load-bearing and cost an hour. `WorldState.history` is a ring the store
   * *mutates* — `fusion/reducer.ts` says so in as many words: "every version shares the same ring
   * object, so a snapshot's view of them is as of the moment it is read, not the moment it was
   * taken". `objectives.recently_lost` reads that ring. So a baseline captured by holding a
   * snapshot and calling `objectives` after the recording finishes reports towers that fell in the
   * *future* of the instant it claims to describe, and the reconstruction — which is correct —
   * fails against it.
   */
  readonly tools: {
    readonly my_state: ToolResultFor<'my_state'>;
    readonly enemy: ToolResultFor<'enemy'>;
    readonly objectives: ToolResultFor<'objectives'>;
    readonly economy: ToolResultFor<'economy'>;
  };
}

interface RecordedMatch {
  readonly contents: string;
  readonly live: readonly LiveMoment[];
  readonly startedAt: number;
}

/**
 * Drives the fixture through a store and a recorder exactly as `buildStateSubsystem` does —
 * `apply` first, `record` second, both with the same `now`. A test that recorded before applying
 * would stamp every line with the previous observation's clock and would still pass most of the
 * assertions below, which is why the ordering is spelled out rather than assumed.
 */
function recordFixture(
  opts: { readonly startedAt?: number; readonly close?: boolean } = {},
): RecordedMatch {
  const startedAt = opts.startedAt ?? 1_000_000;
  const written: string[] = [];
  const sink: RecordSink = {
    writeLine: (line) => written.push(line),
    close: () => undefined,
  };

  const store = createWorldModelStore();
  const recorder = createMatchRecorder({ openSink: () => sink, world: store });
  recorder.open('7891234567', asMonoMs(startedAt));

  const live: LiveMoment[] = [];
  for (const [index, post] of fixturePosts().entries()) {
    const now = asMonoMs(startedAt + post.atMs);
    const o = observation('gsi.payload', post.body, { seq: index, receivedAt: now });
    store.apply(o, now);
    recorder.record(o, now);

    const snapshot = store.snapshot(now);
    live.push({
      atMs: post.atMs,
      clock: snapshot.clock,
      version: snapshot.version,
      lastUpdatedAt: snapshot.state.meta.lastUpdatedAt,
      facts: flattenFacts(snapshot.state),
      tools: {
        my_state: myState(snapshot),
        enemy: enemy(snapshot),
        objectives: objectives(snapshot),
        economy: economy(snapshot),
      },
    });
  }

  if (opts.close === true) recorder.close(asMonoMs(startedAt + 200_000), 'match_ended');

  return { contents: written.map((line) => `${line}\n`).join(''), live, startedAt };
}

/** Every leaf, compared one at a time. A deep-equal of two states would trip on the rings. */
function expectSameFacts(
  actual: WorldState,
  expected: ReadonlyMap<FieldPath, Fact<unknown>>,
): void {
  const got = flattenFacts(actual);
  expect(got.size).toBe(expected.size);
  expect(expected.size).toBeGreaterThan(0);
  for (const [path, fact] of expected) expect(got.get(path), path).toEqual(fact);
}

// -------------------------------------------------------------------------------------------

describe('reading a recording back (the T6 acceptance criterion)', () => {
  const recorded = recordFixture();

  it('reconstructs what the live store held, at every instant, field by field', () => {
    const timeline = openTimeline(recorded.contents);
    const lastAtMs = recorded.live.at(-1)?.atMs ?? 0;
    expect(recorded.live.length).toBeGreaterThanOrEqual(20);

    for (const moment of recorded.live) {
      // Seeking on the wall axis, because it is the one that addresses every POST uniquely: the
      // fixture holds four POSTs at clock 73 (a pause), and a clock query answers at the last of
      // them by design. The clock axis gets its own tests below.
      const found = timeline.at({ secondsAgo: (lastAtMs - moment.atMs) / 1000 });
      expect(isUnknown(found), `no reconstruction at ${String(moment.atMs)}ms`).toBe(false);
      if (isUnknown(found)) continue;

      expect(found.at.atMs, 'landed on the wrong line').toBe(moment.atMs);
      expect(found.snapshot.version, 'version').toBe(moment.version);
      expect(found.snapshot.clock, 'clock').toBe(moment.clock);
      expect(found.snapshot.state.meta.lastUpdatedAt, 'lastUpdatedAt').toBe(moment.lastUpdatedAt);
      expect(found.skipped, 'a keyframe leaf would not load').toEqual([]);
      expectSameFacts(found.snapshot.state, moment.facts);
    }
  });

  it('reads a fact back with the age it had then, not the age it has now', () => {
    // The failure this is about is not a crash: it is "last seen eighteen minutes ago" for a hero
    // the question was about at twelve minutes. True of the recording, useless about the match.
    const timeline = openTimeline(recorded.contents);
    const found = timeline.at({ clock: asGameClock(61) });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;

    const gold = found.snapshot.get(fieldPath('self', 'gold'));
    expect(gold).toBeDefined();
    const ageSeconds = (found.snapshot.now - (gold?.fact.observedAt ?? 0)) / 1000;
    expect(ageSeconds).toBe(0);
    // And the instant itself is where it was asked for, not where the reader happened to be.
    expect(found.snapshot.now).toBe(recorded.startedAt + 106_000);
  });

  it('survives a crash mid-match, answering everything up to the last complete line', () => {
    const killed = recorded.contents.slice(0, recorded.contents.length - 40);
    const timeline = openTimeline(killed);

    expect(timeline.truncated).toBe(true);
    expect(timeline.malformed).toBe(0);
    const found = timeline.at({ clock: asGameClock(91) });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;
    expectSameFacts(
      found.snapshot.state,
      recorded.live.find((moment) => moment.atMs === 146_300)?.facts ?? new Map(),
    );
  });

  it('recovers the header, so atMs is anchored to the monotonic clock the match ran on', () => {
    const timeline = openTimeline(recorded.contents);
    expect(timeline.matchId).toBe('7891234567');
    expect(timeline.startedAt).toBe(1_000_000);
    expect(timeline.keyframeIntervalMs).toBe(30_000);
    expect(timeline.keyframes).toBeGreaterThan(1);
  });
});

// -------------------------------------------------------------------------------------------

describe('replaying each observation at the instant it actually arrived', () => {
  /**
   * A recording whose outcome depends on `now`, which the GSI-only fixture above does not have.
   *
   * `fuse` consults `now` in exactly two places, both of them windows in `precedence.ts`: the GSI
   * shadow and the confidence window. Neither fires in a stream of GSI POSTs, so a replay that
   * stamped every line with the *query's* timestamp reconstructs `laning-phase.jsonl` perfectly
   * and is still wrong — verified by mutation, which is the only reason this test exists.
   *
   * Here a 0.55 sighting lands one second after a 0.91 one. Live, the confidence window refuses
   * it. Replayed at the query's clock the window has long since passed, the blob wins, and the
   * model is told the enemy is somewhere they never were.
   */
  function sightings(): string {
    const written: string[] = [];
    const store = createWorldModelStore();
    const recorder = createMatchRecorder({
      openSink: () => ({ writeLine: (line) => written.push(line), close: () => undefined }),
      world: store,
    });
    recorder.open('sightings', asMonoMs(0));

    const seen = (confidence: number, x: number): unknown => ({
      detections: [
        {
          detector: 'minimap',
          confidence,
          kind: 'hero_position',
          side: 'enemies',
          hero: 'sf',
          x,
          y: 0,
        },
      ],
    });

    for (const [at, payload] of [
      [0, seen(0.91, 100)],
      [1_000, seen(0.55, 900)],
      [9_000, null],
    ] as const) {
      const now = asMonoMs(at);
      const o =
        payload === null
          ? observation('gsi.payload', gsiPayload(), { receivedAt: at })
          : observation('cv.detections', payload, { receivedAt: at });
      store.apply(o, now);
      recorder.record(o, now);
    }

    // The rule being preserved, stated where it is set up: the blob did not land.
    expect(
      store.snapshot(asMonoMs(9_000)).state.enemies.get('sf' as HeroId)?.position?.value,
    ).toEqual({ x: 100, y: 0 });
    return written.map((line) => `${line}\n`).join('');
  }

  it('honours a window the live store closed, instead of one the query happens to open', () => {
    const found = openTimeline(sightings()).at({ secondsAgo: 0 });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;

    const position = found.snapshot.state.enemies.get('sf' as HeroId)?.position;
    expect(position?.value).toEqual({ x: 100, y: 0 });
    expect(position?.confidence).toBe(0.91);
    expect(position?.observedAt).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------

describe('bounded work per query', () => {
  /** An hour of POSTs at 1 Hz, which is the shape the guarantee is about. */
  function longMatch(seconds: number, keyframeIntervalMs: number): RecordedMatch {
    const startedAt = 0;
    const written: string[] = [];
    const store = createWorldModelStore();
    const recorder = createMatchRecorder({
      openSink: () => ({ writeLine: (line) => written.push(line), close: () => undefined }),
      world: store,
      keyframeIntervalMs,
    });
    recorder.open('long', asMonoMs(startedAt));

    for (let second = 0; second < seconds; second += 1) {
      const now = asMonoMs(second * 1000);
      const o = observation('gsi.payload', post(second), { seq: second, receivedAt: now });
      store.apply(o, now);
      recorder.record(o, now);
    }
    return { contents: written.map((line) => `${line}\n`).join(''), live: [], startedAt };
  }

  function post(clockTime: number): unknown {
    return {
      provider: { name: 'Dota 2', appid: 570, version: 47, timestamp: 1_754_000_000 },
      map: {
        matchid: 'long',
        game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
        clock_time: clockTime,
        game_time: clockTime + 90,
        paused: false,
        daytime: true,
      },
      player: { gold: clockTime, gold_reliable: 0, gold_unreliable: clockTime },
    };
  }

  /** The reader's own bound: the delta ring's window, plus the keyframe alignment slack. */
  const CEILING_MS = DEFAULT_HISTORY_WINDOW_SECONDS * 1000 + 30_000;

  it('costs the same at minute fifty-nine as at minute thirty', () => {
    const timeline = openTimeline(longMatch(3_600, 30_000).contents);

    const mid = timeline.at({ clock: asGameClock(1_795) });
    const late = timeline.at({ clock: asGameClock(3_555) });
    expect(isUnknown(mid)).toBe(false);
    expect(isUnknown(late)).toBe(false);
    if (isUnknown(mid) || isUnknown(late)) return;

    // Flatness in match length is the whole guarantee, and it is what a reader that replayed from
    // the start of the file would fail. The two differ only by where the keyframe grid happens to
    // fall relative to the question, which is one interval at most.
    expect(Math.abs(late.replayed - mid.replayed)).toBeLessThanOrEqual(30);
    expect(late.at.atMs - late.from.atMs).toBeLessThanOrEqual(CEILING_MS);
    expect(late.from.reason).toBe('interval');
  });

  it('reaches back a delta window and no further, so recently_lost is not a false empty', () => {
    const timeline = openTimeline(longMatch(3_600, 30_000).contents);
    const found = timeline.at({ clock: asGameClock(3_555) });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;

    // Not "one keyframe interval": the anchor is the newest keyframe old enough to rebuild the
    // ring `objectives.recently_lost` reads (ADR-0048). At 1 Hz that is ~316 observations, and the
    // number is asserted rather than described because the cost of this decision should be visible
    // when somebody changes the window.
    expect(found.at.atMs - found.from.atMs).toBeGreaterThanOrEqual(
      DEFAULT_HISTORY_WINDOW_SECONDS * 1000,
    );
    expect(found.at.atMs - found.from.atMs).toBeLessThanOrEqual(CEILING_MS);
    expect(found.replayed).toBeGreaterThan(300);
    expect(found.replayed).toBeLessThanOrEqual(331);
    expect(found.snapshot.state.history.size).toBeGreaterThan(300);
  });

  it('stays inside a few milliseconds at 8 Hz, which is what the bound is for', () => {
    // The ceiling the header claims. Generous, because a shared CI box is not a benchmark — the
    // point is to fail if a query ever becomes linear in match length, not to measure a machine.
    const timeline = openTimeline(longMatch(1_800, 30_000).contents);
    const started = performance.now();
    for (let clock = 1_500; clock < 1_600; clock += 10) {
      timeline.at({ clock: asGameClock(clock) });
    }
    const perQuery = (performance.now() - started) / 10;
    expect(perQuery).toBeLessThan(100);
  });

  it('says so when a file has no keyframe to anchor on, rather than pretending it is bounded', () => {
    // What `tail -n 200 match.jsonl` leaves. Replaying the prefix from empty is the honest
    // fallback; the reason field is what stops it looking like an ordinary answer.
    const whole = longMatch(60, 30_000)
      .contents.split('\n')
      .filter((line) => line !== '');
    const headless = whole.filter((line) => !line.includes('"kind":"keyframe"')).join('\n');
    const timeline = openTimeline(`${headless}\n`);

    const found = timeline.at({ clock: asGameClock(50) });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;
    expect(found.from.reason).toBe('none');
    expect(found.replayed).toBe(51);
  });
});

// -------------------------------------------------------------------------------------------

describe('the two axes (ADR-0048)', () => {
  const recorded = recordFixture();
  const timeline = openTimeline(recorded.contents);

  it('answers a clock at the last moment that clock was true, which a pause makes visible', () => {
    // The fixture pauses: four POSTs at 118.0 s, 118.3 s, 123.3 s and 128.3 s all report clock 73.
    // A question about 1:13 is a question about all four, and the last of them is the most that
    // was known while the clock read 1:13.
    const found = timeline.at({ clock: asGameClock(73) });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;
    expect(found.at.atMs).toBe(128_300);
    expect(found.at.clock).toBe(73);
  });

  it('answers seconds_ago on the wall clock, which is the axis a pause does not freeze', () => {
    // Same stretch, asked the other way. Five seconds before 128.3 s is 123.3 s — a *different*
    // moment with the *same* match clock, which is exactly the distinction that would be lost if
    // one argument were converted into the other.
    const last = timeline.last?.atMs ?? 0;
    const found = timeline.at({ secondsAgo: (last - 123_300) / 1000 });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;
    expect(found.at.atMs).toBe(123_300);
    expect(found.at.clock).toBe(73);
  });

  it('reads seconds_ago from the end of the recording, so zero is the latest thing known', () => {
    const found = timeline.at({ secondsAgo: 0 });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;
    expect(found.at.atMs).toBe(timeline.last?.atMs);
  });

  it('refuses a moment before the recording rather than answering at its first line', () => {
    expect(timeline.at({ clock: asGameClock(-600) })).toEqual({
      unknown: UNKNOWN_REASONS.beforeRecording,
    });
    expect(timeline.at({ secondsAgo: 10_000 })).toEqual({
      unknown: UNKNOWN_REASONS.beforeRecording,
    });
  });

  it('clamps a moment after the recording to its last line, and says which one that was', () => {
    // Not a refusal: the model asked about the end of a match that has not got there yet, and the
    // newest thing known is a real answer. `at_clock` is what stops it being a silent one.
    const found = timeline.at({ clock: asGameClock(99_999) });
    expect(isUnknown(found)).toBe(false);
    if (isUnknown(found)) return;
    expect(found.at.atMs).toBe(timeline.last?.atMs);
    expect(found.at.clock).toBe(121);
  });

  it('has nothing to say about a clock during the draft, and says that instead of 0:00', () => {
    const written: string[] = [];
    const store = createWorldModelStore();
    const recorder = createMatchRecorder({
      openSink: () => ({ writeLine: (line) => written.push(line), close: () => undefined }),
      world: store,
    });
    recorder.open('drafting', asMonoMs(0));
    const o = observation('gsi.payload', {
      provider: { name: 'Dota 2', appid: 570, version: 47, timestamp: 1 },
      map: { matchid: 'drafting', game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION' },
    });
    store.apply(o, asMonoMs(500));
    recorder.record(o, asMonoMs(500));

    const drafting = openTimeline(written.map((line) => `${line}\n`).join(''));
    expect(drafting.at({ clock: asGameClock(0) })).toEqual({
      unknown: UNKNOWN_REASONS.noClockYet,
    });
    // The wall axis still works, because the draft happened in wall time like everything else.
    expect(isUnknown(drafting.at({ secondsAgo: 0 }))).toBe(false);
  });

  it('has nothing to say about an empty file', () => {
    expect(openTimeline('').at({ secondsAgo: 0 })).toEqual({
      unknown: UNKNOWN_REASONS.beforeRecording,
    });
  });
});

// -------------------------------------------------------------------------------------------
// world_at
// -------------------------------------------------------------------------------------------

/**
 * Stand-ins for T3's four tools, and a record of what they were handed.
 *
 * Every field of every report is `unknown`, which is a *valid* report — the point being asserted
 * is the join, not the rendering. `seen` is what lets the tests below check that the projections
 * were run against the reconstructed instant rather than against anything else.
 */
function probeProjections(available: Partial<Record<keyof WorldAtProjections, boolean>> = {}): {
  readonly projections: WorldAtProjections;
  readonly seen: ToolContext[];
} {
  const seen: ToolContext[] = [];
  const nothing = { unknown: UNKNOWN_REASONS.neverObserved };
  const fact = { unknown: UNKNOWN_REASONS.neverObserved } as const;

  const record = (ctx: ToolContext): void => {
    seen.push(ctx);
  };

  return {
    seen,
    projections: {
      my_state(ctx): ToolResultFor<'my_state'> {
        record(ctx);
        if (available.my_state === false) return nothing;
        return {
          hero: fact,
          team: fact,
          level: fact,
          alive: fact,
          respawn_in_seconds: fact,
          health: fact,
          mana: fact,
          gold: fact,
          buyback: fact,
          items: fact,
          abilities: fact,
        };
      },
      enemy(ctx): ToolResultFor<'enemy'> {
        record(ctx);
        return available.enemy === false ? nothing : { enemies: [] };
      },
      objectives(ctx): ToolResultFor<'objectives'> {
        record(ctx);
        if (available.objectives === false) return nothing;
        return { clock: fact, daytime: fact, buildings: fact, roshan: fact, runes: fact };
      },
      economy(ctx): ToolResultFor<'economy'> {
        record(ctx);
        if (available.economy === false) return nothing;
        return {
          my_net_worth: fact,
          team_net_worth: fact,
          gpm: fact,
          xpm: fact,
          last_hits: fact,
          denies: fact,
          lanes: fact,
        };
      },
    },
  };
}

describe('world_at', () => {
  const recorded = recordFixture();
  const timeline = openTimeline(recorded.contents);

  it('answers with what the live tools said at that instant, because it is calling them', () => {
    // The one assertion that closes T6's loop: no projections passed, so `answerWorldAt` uses
    // `DEFAULT_WORLD_AT_PROJECTIONS`, which is T3's four functions and nothing else. Every value
    // below therefore has to equal what the *live* store produced at 1:01 — the whole envelope,
    // ages included. A second renderer would diverge here on the first field it rounded
    // differently, which is the failure the injected seam exists to make impossible.
    // The last instant, deliberately: by then a tower has fallen, so `objectives` is answering
    // partly out of the delta ring — the one thing a keyframe does not carry and the replay has to
    // rebuild. An earlier instant passes this test with the ring left empty.
    const live = recorded.live.find((moment) => moment.atMs === 176_300)?.tools;
    expect(live).toBeDefined();
    if (live === undefined) return;
    expect(
      isUnknown(live.objectives) || isUnknown(live.objectives.buildings)
        ? []
        : live.objectives.buildings.value.recently_lost,
    ).not.toHaveLength(0);

    const answer = answerWorldAt({ timeline }, { clock: '2:01' });
    expect(TOOLS.world_at.result.safeParse(answer).success).toBe(true);
    expect(isUnknown(answer)).toBe(false);
    if (isUnknown(answer)) return;

    expect(answer.at_clock).toBe('2:01');
    // A tool that answered puts its report in; a tool that refused leaves the section *absent*,
    // because `WorldAtReport` has no unknown branch per section. `enemy` refuses here — nothing has
    // observed the other side in a GSI-only recording — and that absence is the correct answer, not
    // a gap. Asserting both arms in one loop keeps the test honest whichever way a tool goes.
    for (const [section, liveAnswer] of [
      ['my_state', live.my_state],
      ['enemies', live.enemy],
      ['objectives', live.objectives],
      ['economy', live.economy],
    ] as const) {
      const got = (answer as Record<string, unknown>)[section];
      if (isUnknown(liveAnswer)) expect(got, section).toBeUndefined();
      else expect(got, section).toEqual(liveAnswer);
    }
    // …and at least one of them did answer, or the loop above proves nothing.
    expect(answer.my_state).toBeDefined();
    expect(answer.objectives).toBeDefined();
    expect(isUnknown(live.enemy)).toBe(true);
  });

  it('answers in the shape T2 declared, which the schema is the judge of', () => {
    const { projections } = probeProjections();
    const answer = answerWorldAt({ timeline, projections }, { clock: '1:01' });

    // Parsed rather than eyeballed: `encodeToolOutput` will run this exact schema before the
    // answer reaches a model, so a shape that fails here fails there — mid-sentence.
    expect(TOOLS.world_at.result.safeParse(answer).success).toBe(true);
    expect(isUnknown(answer)).toBe(false);
    if (isUnknown(answer)) return;
    expect(Object.keys(answer).sort()).toEqual([
      'at_clock',
      'economy',
      'enemies',
      'my_state',
      'objectives',
    ]);
  });

  it('reports the moment it reconstructed, not the one it was asked for', () => {
    // 1:00 is between two POSTs. The honest answer is the last thing observed at or before it,
    // and saying "0:56" is what stops the model quoting a precision the recording does not have.
    const { projections } = probeProjections();
    const answer = answerWorldAt({ timeline, projections }, { clock: '1:00' });
    expect(isUnknown(answer)).toBe(false);
    if (isUnknown(answer)) return;
    expect(answer.at_clock).toBe('0:56');
  });

  it('narrows to one topic, and calls only that tool', () => {
    const { projections, seen } = probeProjections();
    const answer = answerWorldAt({ timeline, projections }, { clock: '1:01', topic: 'enemy' });

    expect(seen).toHaveLength(1);
    expect(isUnknown(answer)).toBe(false);
    if (isUnknown(answer)) return;
    expect(answer.enemies).toEqual({ enemies: [] });
    expect(answer.my_state).toBeUndefined();
    expect(TOOLS.world_at.result.safeParse(answer).success).toBe(true);
  });

  it('takes "thirty seconds ago" and answers about the match clock it lands on', () => {
    const { projections } = probeProjections();
    const answer = answerWorldAt({ timeline, projections }, { seconds_ago: 35 });
    expect(isUnknown(answer)).toBe(false);
    if (isUnknown(answer)) return;
    // 176.3 s minus 35 s is 141.3 s of wall clock, which the recording stamps at 1:26.
    expect(answer.at_clock).toBe('1:26');
  });

  it('hands the projections the reconstructed instant, not the present', () => {
    const { projections, seen } = probeProjections();
    answerWorldAt({ timeline, projections }, { clock: '1:01', topic: 'my_state' });
    expect(seen[0]?.now).toBe(1_000_000 + 106_000);
    expect(seen[0]?.clock).toBe(61);
  });

  it('omits a section that had nothing to say, and keeps the ones that did', () => {
    const { projections } = probeProjections({ my_state: false, economy: false });
    const answer = answerWorldAt({ timeline, projections }, { clock: '1:01' });
    expect(isUnknown(answer)).toBe(false);
    if (isUnknown(answer)) return;
    expect(Object.keys(answer).sort()).toEqual(['at_clock', 'enemies', 'objectives']);
    expect(TOOLS.world_at.result.safeParse(answer).success).toBe(true);
  });

  it('returns the topic’s own reason when the one topic asked for had nothing', () => {
    const { projections } = probeProjections({ enemy: false });
    expect(answerWorldAt({ timeline, projections }, { clock: '1:01', topic: 'enemy' })).toEqual({
      unknown: UNKNOWN_REASONS.neverObserved,
    });
  });

  it('refuses an answer with no sections in it, because that is silence dressed as an answer', () => {
    const { projections } = probeProjections({
      my_state: false,
      enemy: false,
      objectives: false,
      economy: false,
    });
    const answer = answerWorldAt({ timeline, projections }, { clock: '1:01' });
    expect(answer).toEqual({ unknown: 'nothing was observed at 1:01' });
    expect(TOOLS.world_at.result.safeParse(answer).success).toBe(true);
  });

  it('passes a refusal from the timeline straight through', () => {
    const { projections, seen } = probeProjections();
    expect(answerWorldAt({ timeline, projections }, { clock: '-59:00' })).toEqual({
      unknown: UNKNOWN_REASONS.beforeRecording,
    });
    expect(seen).toHaveLength(0);
  });

  it('answers rather than throws when the arguments never went through the validator', () => {
    // `parseToolCall` refuses both-at-once and neither-at-all before this is reached. If some
    // other caller does not, the turn degrades to a sentence instead of stopping.
    const { projections } = probeProjections();
    for (const args of [{}, { clock: '1:01', seconds_ago: 30 }, { clock: 'noon' }]) {
      const answer = answerWorldAt({ timeline, projections }, args);
      expect(isUnknown(answer)).toBe(true);
      expect(TOOLS.world_at.result.safeParse(answer).success).toBe(true);
    }
  });
});

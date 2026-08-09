/**
 * The recorder wired into state capture, and the claim the whole format exists for:
 * **a recorded match is a `fixtures/gsi/*.jsonl` fixture.**
 *
 * `packages/world-model` may not import a source (ADR-0014), so the recorder's own tests can only
 * assert the shape of what it writes. This is the file where both halves are in the room: a real
 * `FakeGsiSource` replays `fixtures/gsi/laning-phase.jsonl` through the real subsystem into a real
 * file, and then a second `FakeGsiSource` replays *that file* and has to produce the same POSTs.
 * If the two formats ever diverge, this is what says so.
 *
 * The clock advances by the gaps the fixture records rather than by a flat step per line, for the
 * reason `shell.test.ts` records: `packages/gsi` compares the game clock against elapsed wall time,
 * and inventing a pace makes them disagree. Here it matters for a second reason — the keyframe
 * interval is measured on that clock, so a replay that ran in zero wall time would produce exactly
 * one keyframe and the interval would be untested.
 */

import { readFileSync, mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Timers } from '@riki/context';
import type { MatchLifecycleEvent } from '@riki/gsi';
import { createGsiPayloadParser } from '@riki/gsi';
import { createFakeGsiSource, parseGsiFixture } from '@riki/gsi/testing';
import type { Clock, MonoMs, Observation } from '@riki/world-model';
import {
  createFileRecordSinks,
  matchFileName,
  parseRecordLines,
  type KeyframeLine,
  type ObservationLine,
} from '@riki/world-model';

import { buildStateSubsystem, type StateSubsystemWithExtras } from './index.js';
import { NO_RESTART } from './contracts.js';

const FIXTURE = 'fixtures/gsi/laning-phase.jsonl';
const FIXTURE_LINES = parseGsiFixture(readFileSync(FIXTURE, 'utf8'));
const MATCH_ID = '7891234567';

/** Keys that belong to a record line and must never reach the GSI parser as POST components. */
const ENVELOPE_KEYS = new Set(['atMs', 'kind', 'clock', 'state', 'seq', 'receivedAt', 'sourceId']);

/** Timers nothing in this file fires; the supervisor only uses them for restart backoff. */
const idleTimers: Timers = { after: () => () => undefined };

interface MovableClock extends Clock {
  set(ms: number): void;
}

function movableClock(): MovableClock {
  let current = 0;
  return {
    now: (): MonoMs => current as MonoMs,
    set(ms: number): void {
      current = ms;
    },
  };
}

interface Harness {
  readonly state: StateSubsystemWithExtras;
  readonly directory: string;
  readonly path: string;
  fire(event: MatchLifecycleEvent): void;
  /** Replays the whole fixture at recorded timing, moving the clock as it goes. */
  replay(): Promise<void>;
  contents(): string;
}

let harness: Harness | null = null;

function build(keyframeIntervalMs?: number): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'riki-matches-'));
  const clock = movableClock();
  const gsi = createFakeGsiSource({ lines: FIXTURE_LINES, clock });
  const lifecycle: { fire: ((events: readonly MatchLifecycleEvent[]) => void) | null } = {
    fire: null,
  };

  const state = buildStateSubsystem({
    clock,
    timers: idleTimers,
    sources: [
      {
        policy: NO_RESTART,
        // `FakeGsiSource` satisfies `SupervisedSource`, so the bus, the store and the recorder are
        // all the real thing — only the socket is missing.
        source: gsi,
        lifecycle: (listener) => {
          lifecycle.fire = listener;
          return () => undefined;
        },
      },
    ],
    recording: {
      openSink: createFileRecordSinks(directory),
      ...(keyframeIntervalMs === undefined ? {} : { keyframeIntervalMs }),
    },
  });

  return {
    state,
    directory,
    path: join(directory, matchFileName(MATCH_ID)),
    fire(event) {
      lifecycle.fire?.([event]);
    },
    async replay(): Promise<void> {
      await state.start();
      for (const line of FIXTURE_LINES) {
        clock.set(line.atMs);
        gsi.step();
      }
    },
    contents(): string {
      return readFileSync(this.path, 'utf8');
    },
  };
}

beforeEach(() => {
  harness = build();
});

afterEach(async () => {
  const current = harness;
  harness = null;
  if (current === null) return;
  await current.state.stop();
  rmSync(current.directory, { recursive: true, force: true });
});

function open(): Harness {
  const current = harness;
  if (current === null) throw new Error('no harness');
  current.fire({ type: 'match_started', matchId: MATCH_ID, heroes: [] });
  return current;
}

// -------------------------------------------------------------------------------------------

describe('a recorded match', () => {
  it('lands at matches/<matchId>.jsonl and holds one line per observation', async () => {
    const test = open();
    await test.replay();
    test.fire({ type: 'match_ended', matchId: MATCH_ID } as MatchLifecycleEvent);

    expect(statSync(test.path).isFile()).toBe(true);
    const parsed = parseRecordLines(test.contents());
    expect(parsed.malformed).toBe(0);
    expect(parsed.truncated).toBe(false);

    const observations = parsed.lines.filter(
      (line): line is ObservationLine => line.kind === 'gsi.payload',
    );
    expect(observations).toHaveLength(FIXTURE_LINES.length);
    expect(parsed.lines[0]?.kind).toBe('header');
    expect(parsed.lines.at(-1)?.kind).toBe('keyframe');
  });

  it('is a fixture: a second FakeGsiSource replays the recording and produces the same POSTs', async () => {
    const test = open();
    await test.replay();
    test.fire({ type: 'match_ended', matchId: MATCH_ID } as MatchLifecycleEvent);

    // This is the `tools/gsi-replay` path, exactly: read the file with the fixture parser, hand it
    // to the source that drives `pnpm dev:replay`, and drain it.
    const replayed: Observation[] = [];
    const source = createFakeGsiSource({
      lines: parseGsiFixture(test.contents()),
      clock: { now: (): MonoMs => 0 as MonoMs },
    });
    source.subscribe((o) => replayed.push(o));
    source.drain();

    const parser = createGsiPayloadParser();
    const original = FIXTURE_LINES.map((line) => {
      const parsed = parser.parse(line.body);
      return parsed.ok ? parsed.value.map?.clock_time : undefined;
    });
    const roundTripped = replayed
      .map((o) => (o.payload as { map?: { clock_time?: number } }).map?.clock_time)
      .filter((clock) => clock !== undefined);

    expect(roundTripped).toEqual(original);
  });

  it('carries the header and keyframes past a fixture reader without inventing observations', async () => {
    const test = open();
    await test.replay();
    test.fire({ type: 'match_ended', matchId: MATCH_ID } as MatchLifecycleEvent);

    const fixtureLines = parseGsiFixture(test.contents());
    const parsed = parseRecordLines(test.contents());
    // Every line is readable as a fixture line — including the header and the keyframes, which is
    // the property `body: {}` buys.
    expect(fixtureLines).toHaveLength(parsed.lines.length);

    // And none of them hands the record *envelope* to the GSI parser. This is the assertion that
    // actually catches a missing `body`: `parseGsiFixture` falls back to `parsed.body ?? parsed`,
    // and `createGsiPayloadParser` accepts any object and files what it does not recognise under
    // `unknown` — so a keyframe with no `body` replays as a POST whose `unknown` holds the whole
    // serialised world. Asserting the parse merely succeeded proves nothing; every object parses.
    const parser = createGsiPayloadParser();
    for (const line of fixtureLines) {
      const result = parser.parse(line.body);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(Object.keys(result.value.unknown).filter((key) => ENVELOPE_KEYS.has(key))).toEqual([]);
    }
    const keyframes = parsed.lines.filter((line): line is KeyframeLine => line.kind === 'keyframe');
    for (const frame of keyframes) expect(frame.body).toEqual({});
  });

  it('writes a keyframe every interval across the replay, not just at the ends', async () => {
    await harness!.state.stop();
    rmSync(harness!.directory, { recursive: true, force: true });
    // The fixture spans ~176 s of wall time; a 30 s interval should produce several keyframes.
    harness = build(30_000);
    const test = open();
    await test.replay();
    test.fire({ type: 'match_ended', matchId: MATCH_ID } as MatchLifecycleEvent);

    const keyframes = parseRecordLines(test.contents()).lines.filter(
      (line): line is KeyframeLine => line.kind === 'keyframe',
    );
    const intervals = keyframes.filter((frame) => frame.reason === 'interval');
    expect(intervals.length).toBeGreaterThanOrEqual(4);
    expect(keyframes[0]?.reason).toBe('open');
    expect(keyframes.at(-1)?.reason).toBe('match_ended');

    // A keyframe carries the model as it stood, which is what `world_at` seeks back to.
    const last = intervals.at(-1);
    expect(last?.state.facts['meta.matchId']).toMatchObject({ value: MATCH_ID, source: 'gsi' });
    expect(last?.state.facts['self.hero']).toBeDefined();
  });

  it('survives being killed mid-match: the file still parses to the last complete line', async () => {
    const test = open();
    await test.replay();
    // No `match_ended`, no `stop()` — the process is simply gone. Everything written so far is
    // already on the filesystem, because the sink does not buffer.
    const whole = parseRecordLines(test.contents());
    expect(whole.lines.length).toBeGreaterThan(FIXTURE_LINES.length);

    truncateSync(test.path, statSync(test.path).size - 25);
    const partial = parseRecordLines(test.contents());

    expect(partial.truncated).toBe(true);
    expect(partial.malformed).toBe(0);
    expect(partial.lines).toHaveLength(whole.lines.length - 1);
    expect(partial.lines.at(-1)).toEqual(whole.lines.at(-2));
  });

  it('records nothing between matches, and says how much it skipped', async () => {
    const test = harness!;
    await test.replay();

    expect(test.state.recorder?.matchId).toBeNull();
    expect(test.state.recorder?.stats.unrecorded).toBe(FIXTURE_LINES.length);
    expect(() => statSync(test.path)).toThrow();
  });

  it('closes the recording when the app quits mid-match, before the world model is emptied', async () => {
    const test = open();
    await test.replay();
    await test.state.stop();

    const keyframes = parseRecordLines(test.contents()).lines.filter(
      (line): line is KeyframeLine => line.kind === 'keyframe',
    );
    const closing = keyframes.at(-1);
    expect(closing?.reason).toBe('shutdown');
    // The reset that `stop()` performs happens after: a closing keyframe of the emptied model
    // would record a match that ended with nothing observed.
    expect(Object.keys(closing?.state.facts ?? {}).length).toBeGreaterThan(0);
  });

  it('starts a new file, and a new recording, when a second match begins', async () => {
    const test = open();
    await test.replay();
    test.fire({ type: 'match_started', matchId: '999', heroes: [] });

    expect(test.state.recorder?.matchId).toBe('999');
    const second = join(test.directory, matchFileName('999'));
    expect(statSync(second).isFile()).toBe(true);
    // The first is closed rather than left open.
    const first = parseRecordLines(test.contents()).lines.at(-1);
    expect(first?.kind).toBe('keyframe');
    expect((first as KeyframeLine).reason).toBe('superseded');
  });

  it('does not record without being asked — the subsystem has no recorder by default', async () => {
    const state = buildStateSubsystem({
      clock: movableClock(),
      timers: idleTimers,
      sources: [],
    });
    await state.start();

    expect(state.recorder).toBeNull();
    await state.stop();
  });
});

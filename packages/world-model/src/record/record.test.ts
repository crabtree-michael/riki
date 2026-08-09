/**
 * The recorder's four promises, each asserted where it is made.
 *
 * 1. A keyframe round-trips the model field by field — which is what `world_at` is built on.
 * 2. The cadence is one line per observation and one keyframe per interval, no more.
 * 3. A file cut in half by a crash still parses to its last complete line.
 * 4. Nothing here can take state capture down, and nothing here writes somebody else's words.
 *
 * That the resulting file is readable by `FakeGsiSource` is asserted in
 * `apps/desktop/src/main/state/recording.test.ts` — `packages/world-model` may not import a source
 * (ADR-0014), so the compatibility claim has to be made where both halves are in the room.
 */

import { describe, expect, it } from 'vitest';

import { asConfidence, cvFact, gsiFact } from '../fact.js';
import type { FieldPath, HeroId } from '../state.js';
import { emptyState, fieldPath, flattenFacts, heroField, writeFact } from '../state.js';
import { createWorldModelStore } from '../store.js';
import { asDetectorId } from '../fact.js';
import { asGameClock, asMonoMs } from '../time.js';
import { gsiPayload, observation } from '../testing/index.js';
import type { RecordSink } from './recorder.js';
import { createMatchRecorder, DEFAULT_KEYFRAME_INTERVAL_MS } from './recorder.js';
import type { KeyframeLine, ObservationLine, RecordLine } from './format.js';
import { RECORD_FORMAT_VERSION, parseRecordLines } from './format.js';
import { deserialiseWorldState, serialiseWorldState } from './keyframe.js';
import { matchFileName } from './file-sink.js';

// -------------------------------------------------------------------------------------------

interface MemorySink extends RecordSink {
  readonly written: readonly string[];
  readonly closes: number;
}

function memorySink(onWrite?: (line: string, index: number) => void): MemorySink {
  const written: string[] = [];
  let closes = 0;
  return {
    writeLine(line: string): void {
      onWrite?.(line, written.length);
      written.push(line);
    },
    close(): void {
      closes += 1;
    },
    get written(): readonly string[] {
      return written;
    },
    get closes(): number {
      return closes;
    },
  };
}

/** The file a sink accumulated, as a reader would see it. */
function contentsOf(sink: MemorySink): string {
  return sink.written.map((line) => `${line}\n`).join('');
}

function linesOf(sink: MemorySink): readonly RecordLine[] {
  return parseRecordLines(contentsOf(sink)).lines;
}

function keyframesOf(sink: MemorySink): readonly KeyframeLine[] {
  return linesOf(sink).filter((line): line is KeyframeLine => line.kind === 'keyframe');
}

/** A store with a few facts in it, so a keyframe has something to carry. */
function populatedStore(): ReturnType<typeof createWorldModelStore> {
  const store = createWorldModelStore();
  store.apply(
    observation('gsi.payload', gsiPayload({ player: { kills: 3, deaths: 1, assists: 5 } })),
    asMonoMs(1_000),
  );
  return store;
}

// -------------------------------------------------------------------------------------------

describe('a keyframe (conversational-architecture.md §6)', () => {
  it('round-trips every leaf the model holds, which is what world_at replays forward from', () => {
    const store = populatedStore();
    const before = store.snapshot(asMonoMs(2_000)).state;

    const { state: after, skipped } = deserialiseWorldState(serialiseWorldState(before));

    expect(skipped).toEqual([]);
    expect(after.version).toBe(before.version);
    expect(after.meta.lastUpdatedAt).toBe(before.meta.lastUpdatedAt);

    // Field by field rather than a deep-equal of the two states: the rings deliberately differ,
    // and a whole-object comparison would either fail on that or be loosened until it proved
    // nothing.
    const expected = flattenFacts(before);
    const actual = flattenFacts(after);
    expect(actual.size).toBe(expected.size);
    expect(expected.size).toBeGreaterThan(0);
    for (const [path, fact] of expected) expect(actual.get(path)).toEqual(fact);
  });

  it('carries a CV fact with its confidence and its detector, not just its value', () => {
    const hero = 'sf' as HeroId;
    const path = heroField('enemies', hero, 'position');
    const fact = cvFact(
      { x: 100, y: -200 },
      { observedAt: asMonoMs(4_000), atGameClock: asGameClock(612) },
      asConfidence(0.55),
      asDetectorId('minimap-blob'),
    );
    const before = writeFact(emptyState(asMonoMs(0)), path, fact);

    const { state: after } = deserialiseWorldState(serialiseWorldState(before));

    expect(after.enemies.get(hero)?.position).toEqual(fact);
  });

  it('keeps never-observed apart from observed-as-zero, which is the whole point of the model', () => {
    const before = emptyState(asMonoMs(0));
    const serialised = serialiseWorldState(before);

    expect(Object.keys(serialised.facts)).not.toContain('self.netWorth');

    const { state: after } = deserialiseWorldState(serialised);
    expect(after.self.netWorth).toBeUndefined();
  });

  it('does not carry the chat ring, because those are other people’s words (dota2 §7)', () => {
    const store = createWorldModelStore();
    store.apply(
      observation('log.event', { kind: 'chat', text: 'gg ez', speaker: 'someone', channel: 'all' }),
      asMonoMs(500),
    );
    const before = store.snapshot(asMonoMs(600)).state;
    expect(before.chat.size).toBe(1);

    const { state: after } = deserialiseWorldState(serialiseWorldState(before));

    expect(after.chat.size).toBe(0);
    expect(JSON.stringify(serialiseWorldState(before))).not.toContain('gg ez');
  });

  it('drops a corrupted confidence rather than clamping it into certainty', () => {
    const store = populatedStore();
    const serialised = serialiseWorldState(store.snapshot(asMonoMs(2_000)).state);
    const corrupted = {
      ...serialised,
      facts: {
        ...serialised.facts,
        'self.kda': { ...serialised.facts['self.kda'], confidence: 1.4 },
      },
    };

    const { state, skipped } = deserialiseWorldState(
      corrupted as unknown as ReturnType<typeof serialiseWorldState>,
    );

    expect(skipped).toEqual(['self.kda']);
    expect(state.self.kda).toBeUndefined();
  });

  it('reports a path that names no leaf instead of silently dropping it', () => {
    const serialised = serialiseWorldState(emptyState(asMonoMs(0)));
    const withTypo = {
      ...serialised,
      facts: {
        ...serialised.facts,
        'self.helth': serialised.facts[fieldPath('meta', 'phase')],
      },
    };

    const { skipped } = deserialiseWorldState(
      withTypo as unknown as ReturnType<typeof serialiseWorldState>,
    );

    expect(skipped).toEqual(['self.helth']);
  });
});

// -------------------------------------------------------------------------------------------

describe('the recorder', () => {
  it('opens with a header and a keyframe, so the first thirty seconds are answerable', () => {
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: populatedStore() });

    recorder.open('7891234567', asMonoMs(10_000));

    const lines = linesOf(sink);
    expect(lines).toHaveLength(2);
    const header = lines[0];
    expect(header?.kind).toBe('header');
    expect(header?.atMs).toBe(0);
    expect(header).toMatchObject({ format: RECORD_FORMAT_VERSION, matchId: '7891234567' });
    expect(lines[1]?.kind).toBe('keyframe');
    expect(recorder.matchId).toBe('7891234567');
  });

  it('appends one line per observation, stamped on both clocks', () => {
    const store = populatedStore();
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: store });

    recorder.open('m', asMonoMs(1_000));
    recorder.record(observation('gsi.payload', gsiPayload(), { seq: 7 }), asMonoMs(1_250));

    const line = linesOf(sink).at(-1) as ObservationLine;
    expect(line.kind).toBe('gsi.payload');
    // `atMs` is relative to `open`, which is what makes the file replayable at recorded timing;
    // `receivedAt` keeps the raw monotonic stamp the observation arrived with.
    expect(line.atMs).toBe(250);
    expect(line.seq).toBe(7);
    // The store has a clock by now, and the line carries it — this is what `world_at` seeks on.
    expect(line.clock).toBe(600);
  });

  it('writes a keyframe every interval and not more often', () => {
    const store = populatedStore();
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: store });

    recorder.open('m', asMonoMs(0));
    for (let at = 1_000; at <= 70_000; at += 1_000) {
      recorder.record(observation('gsi.payload', gsiPayload()), asMonoMs(at));
    }

    // Open, then 30 s and 60 s. Seventy seconds of recording, three keyframes.
    const frames = keyframesOf(sink);
    expect(frames.map((frame) => frame.reason)).toEqual(['open', 'interval', 'interval']);
    expect(frames.map((frame) => frame.atMs)).toEqual([0, 30_000, 60_000]);
    expect(DEFAULT_KEYFRAME_INTERVAL_MS).toBe(30_000);
  });

  it('writes a closing keyframe on match_ended, then closes the descriptor', () => {
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: populatedStore() });

    recorder.open('m', asMonoMs(0));
    recorder.close(asMonoMs(5_000), 'match_ended');

    expect(keyframesOf(sink).at(-1)?.reason).toBe('match_ended');
    expect(sink.closes).toBe(1);
    expect(recorder.matchId).toBeNull();

    // Closing twice is what a match that ends during shutdown does. It must not write again.
    const before = sink.written.length;
    recorder.close(asMonoMs(6_000), 'shutdown');
    expect(sink.written).toHaveLength(before);
  });

  it('records that a chat line happened without recording what was said', () => {
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: populatedStore() });

    recorder.open('m', asMonoMs(0));
    recorder.record(
      observation('log.event', {
        kind: 'chat',
        text: 'report mid',
        speaker: 'someone',
        channel: 'all',
      }),
      asMonoMs(1_000),
    );

    expect(contentsOf(sink)).not.toContain('report mid');
    expect(contentsOf(sink)).not.toContain('someone');
    const line = linesOf(sink).at(-1) as ObservationLine;
    expect(line.redacted).toBe(true);
    // The event itself survives: that somebody spoke at this instant is a fact about the match.
    expect(line.body).toEqual({ kind: 'chat', channel: 'all' });
  });

  it('leaves a public log event alone', () => {
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: populatedStore() });

    recorder.open('m', asMonoMs(0));
    recorder.record(
      observation('log.event', { kind: 'kill', victim: 'sf', killer: 'pudge' }),
      asMonoMs(1_000),
    );

    const line = linesOf(sink).at(-1) as ObservationLine;
    expect(line.redacted).toBeUndefined();
    expect(line.body).toEqual({ kind: 'kill', victim: 'sf', killer: 'pudge' });
  });

  it('ends the recording when the sink fails, and never throws at the caller', () => {
    const failures: string[] = [];
    const sink = memorySink((_line, index) => {
      if (index === 2) throw new Error('ENOSPC: no space left on device');
    });
    const recorder = createMatchRecorder({
      openSink: () => sink,
      world: populatedStore(),
      telemetry: {
        recordingOpened: () => undefined,
        recordingClosed: () => undefined,
        recordingFailed: (_id, reason) => failures.push(reason),
      },
    });

    recorder.open('m', asMonoMs(0));
    // Header and opening keyframe are writes 0 and 1; the first observation is the one that fails.
    expect(() => {
      recorder.record(observation('gsi.payload', gsiPayload()), asMonoMs(1_000));
    }).not.toThrow();
    recorder.record(observation('gsi.payload', gsiPayload()), asMonoMs(2_000));

    expect(failures).toEqual(['ENOSPC: no space left on device']);
    expect(recorder.matchId).toBeNull();
    expect(sink.closes).toBe(1);
    // Everything written before the failure is still there, and still parses.
    expect(parseRecordLines(contentsOf(sink)).lines).toHaveLength(2);
    // The observations that arrive after are counted rather than pretended away.
    expect(recorder.stats.unrecorded).toBe(1);
    expect(recorder.stats.failures).toBe(1);
  });

  it('counts observations that arrive with no match open, rather than dropping them silently', () => {
    const recorder = createMatchRecorder({ openSink: () => memorySink(), world: populatedStore() });

    recorder.record(observation('gsi.payload', gsiPayload()), asMonoMs(1_000));

    expect(recorder.stats.unrecorded).toBe(1);
  });

  it('closes the previous recording when a second match opens on top of it', () => {
    const sinks: MemorySink[] = [];
    const recorder = createMatchRecorder({
      openSink: () => {
        const sink = memorySink();
        sinks.push(sink);
        return sink;
      },
      world: populatedStore(),
    });

    recorder.open('first', asMonoMs(0));
    recorder.open('second', asMonoMs(1_000));

    expect(sinks).toHaveLength(2);
    expect(sinks[0]?.closes).toBe(1);
    expect(keyframesOf(sinks[0]!).at(-1)?.reason).toBe('superseded');
    expect(recorder.matchId).toBe('second');
  });
});

// -------------------------------------------------------------------------------------------

describe('reading a recording back', () => {
  it('parses to the last complete line when a crash cut the file in half', () => {
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: populatedStore() });
    recorder.open('m', asMonoMs(0));
    for (let at = 1_000; at <= 4_000; at += 1_000) {
      recorder.record(observation('gsi.payload', gsiPayload()), asMonoMs(at));
    }

    const whole = contentsOf(sink);
    const intact = parseRecordLines(whole);
    // A SIGKILL lands wherever it lands. Cut mid-line rather than at a boundary.
    const killed = whole.slice(0, whole.length - 40);
    expect(killed.endsWith('\n')).toBe(false);

    const partial = parseRecordLines(killed);
    expect(partial.truncated).toBe(true);
    expect(partial.malformed).toBe(0);
    expect(partial.lines).toHaveLength(intact.lines.length - 1);
    expect(partial.lines.at(-1)).toEqual(intact.lines.at(intact.lines.length - 2));
  });

  it('reports a corrupt line in the middle as corruption, not as a truncated tail', () => {
    const parsed = parseRecordLines('{"atMs":0,"kind":"header","matchId":"m","body":{}}\n{oops\n');

    expect(parsed.lines).toHaveLength(1);
    expect(parsed.truncated).toBe(false);
    expect(parsed.malformed).toBe(1);
  });

  it('skips the // header a fixture is allowed to carry', () => {
    const parsed = parseRecordLines(
      '// SYNTHETIC — assembled, not captured\n\n{"atMs":0,"kind":"header","matchId":"m","body":{}}\n',
    );

    expect(parsed.lines).toHaveLength(1);
    expect(parsed.malformed).toBe(0);
  });

  it('keeps a match id out of the path it is interpolated into', () => {
    expect(matchFileName('7891234567')).toBe('7891234567.jsonl');
    expect(matchFileName('../../etc/passwd')).toBe('______etc_passwd.jsonl');
    expect(matchFileName('')).toBe('unknown.jsonl');
  });
});

// -------------------------------------------------------------------------------------------

describe('the fixture compatibility rule (format.ts)', () => {
  it('gives every line an atMs and a body, so a GSI fixture reader can step over all of them', () => {
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: populatedStore() });

    recorder.open('m', asMonoMs(0));
    recorder.record(observation('gsi.payload', gsiPayload()), asMonoMs(1_000));
    recorder.close(asMonoMs(2_000), 'match_ended');

    for (const line of sink.written) {
      const raw = JSON.parse(line) as Record<string, unknown>;
      expect(typeof raw.atMs).toBe('number');
      // The load-bearing field. Without it `parseGsiFixture`'s `parsed.body ?? parsed` hands the
      // *keyframe* to the GSI parser, which accepts almost any object.
      expect(raw.body).toBeDefined();
    }
  });

  it('puts the raw POST body in `body`, unchanged, so a replay drives the real parser', () => {
    const sink = memorySink();
    const recorder = createMatchRecorder({ openSink: () => sink, world: populatedStore() });
    const payload = gsiPayload();

    recorder.open('m', asMonoMs(0));
    recorder.record(observation('gsi.payload', payload), asMonoMs(1_000));

    expect((linesOf(sink).at(-1) as ObservationLine).body).toEqual(payload);
  });
});

// -------------------------------------------------------------------------------------------

describe('a path that names no leaf', () => {
  it('is rejected by writeFact, which is why deserialise can count it', () => {
    const state = emptyState(asMonoMs(0));
    const fact = gsiFact(1, { observedAt: asMonoMs(0), atGameClock: null });
    expect(writeFact(state, 'self.helth' as FieldPath, fact)).toBe(state);
  });
});

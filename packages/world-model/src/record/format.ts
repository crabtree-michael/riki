/**
 * The on-disk line format, and the only place that knows how a match recording is spelled.
 *
 * A recording is JSONL at `<dataDir>/matches/<matchId>.jsonl`, and it has one hard compatibility
 * obligation: **`tools/gsi-replay` and `FakeGsiSource` must be able to consume it unchanged**
 * (conversational-architecture.md §6). Those read `fixtures/gsi/*.jsonl`, whose line shape is
 * `{ atMs, body }` — `atMs` milliseconds from the start of the recording, `body` the raw POST.
 *
 * So every line here carries `atMs` and `body`, including the lines that are not GSI POSTs:
 *
 * - An **observation** line puts the observation's payload in `body`, and its own envelope
 *   (`sourceId`, `seq`, `receivedAt`, `v`) alongside. A GSI observation line is therefore
 *   byte-compatible with a fixture line, with extra keys a fixture reader ignores.
 * - A **keyframe** and the **header** carry `body: {}`. An empty object is a well-formed GSI POST
 *   that observes nothing, so a replay tool steps over them and fuses nothing — as opposed to
 *   omitting `body`, where `parseGsiFixture`'s `parsed.body ?? parsed` would hand the *keyframe*
 *   to the GSI parser, which accepts almost anything and would turn it into a bogus observation.
 *   That single field is the whole reason the two formats can be one format.
 *
 * `atMs` is relative to `open()` rather than a wall clock for the same reason a fixture's is: a
 * recording carrying absolute timestamps replays differently depending on when it was recorded.
 * `receivedAt` keeps the raw monotonic stamp for anything that needs the original ordering.
 *
 * ## Reading a file that a crash cut in half
 *
 * `parseRecordLines` is written for the killed-process case rather than treating it as an error:
 * the last line of a recording is routinely a partial one, and a reader that throws on it loses
 * the whole match to recover a few hundred bytes. A truncated tail is reported, never silent.
 */

import { asRecord } from '../fusion/candidate.js';
import type { ObservationKind } from '../observation.js';
import type { SerialisedWorldState } from './keyframe.js';

/** Bumped when a line shape changes in a way an older reader would misread. Written in the header. */
export const RECORD_FORMAT_VERSION = 1;

export type RecordLineKind = ObservationKind | 'header' | 'keyframe';

const OBSERVATION_KINDS: readonly string[] = [
  'gsi.payload',
  'log.event',
  'cv.detections',
  'api.enrichment',
];

interface RecordLineBase {
  /** Milliseconds since `open()`. The field `FakeGsiSource` paces a replay on. */
  readonly atMs: number;
  readonly kind: RecordLineKind;
  /** `map.clock_time` when the line was written, or null before the horn. What `world_at` seeks on. */
  readonly clock: number | null;
  /** A GSI POST body for observation lines, `{}` for everything else. See the header note. */
  readonly body: unknown;
}

export interface HeaderLine extends RecordLineBase {
  readonly kind: 'header';
  readonly format: number;
  readonly matchId: string;
  /** The monotonic reading `atMs` counts from, so absolute stamps can be recovered. */
  readonly startedAt: number;
  readonly keyframeIntervalMs: number;
}

export interface ObservationLine extends RecordLineBase {
  readonly kind: ObservationKind;
  readonly sourceId: string;
  readonly seq: number;
  readonly receivedAt: number;
  readonly v: number;
  /**
   * Present and true when the payload reached disk with a field removed. Today that is chat text
   * and nothing else — see `redactForDisk` in recorder.ts.
   */
  readonly redacted?: boolean;
}

export interface KeyframeLine extends RecordLineBase {
  readonly kind: 'keyframe';
  readonly receivedAt: number;
  readonly version: number;
  /** Why this keyframe exists: the interval, a reset, or the open/close of the recording. */
  readonly reason: string;
  readonly state: SerialisedWorldState;
}

export type RecordLine = HeaderLine | ObservationLine | KeyframeLine;

export function encodeRecordLine(line: RecordLine): string {
  return JSON.stringify(line);
}

export interface ParsedRecording {
  readonly lines: readonly RecordLine[];
  /**
   * The file ended mid-line — the shape a `SIGKILL` leaves. Everything before it is intact and is
   * in `lines`.
   */
  readonly truncated: boolean;
  /** Lines that were neither blank, a comment, nor a readable record line. Never silent. */
  readonly malformed: number;
}

/**
 * Every complete line of a recording, plus what was lost.
 *
 * Blank lines and `//` lines are skipped, matching `parseGsiFixture` — a recording is a fixture,
 * and a fixture is allowed a header saying where it came from.
 */
export function parseRecordLines(contents: string): ParsedRecording {
  const lines: RecordLine[] = [];
  let malformed = 0;

  // A file that ends with a newline has no partial tail; one that does not may have. The split
  // below produces a trailing `''` in the first case, which the blank-line skip absorbs.
  const chunks = contents.split('\n');
  const lastIndex = chunks.length - 1;
  const endsClean = chunks[lastIndex] === '';
  let truncated = false;

  for (const [index, chunk] of chunks.entries()) {
    const text = chunk.trim();
    if (text === '' || text.startsWith('//')) continue;

    const line = parseRecordLine(text);
    if (line !== null) {
      lines.push(line);
      continue;
    }

    // Only the final chunk of a file with no trailing newline can be a half-written line. An
    // unreadable line anywhere else is corruption, and calling it truncation would hide it.
    if (index === lastIndex && !endsClean) truncated = true;
    else malformed += 1;
  }

  return { lines, truncated, malformed };
}

/** One line, or null if it is not a record line at all. */
export function parseRecordLine(text: string): RecordLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (record === undefined) return null;

  const atMs = record.atMs;
  const kind = record.kind;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
  if (typeof kind !== 'string') return null;

  const clock = typeof record.clock === 'number' ? record.clock : null;

  if (kind === 'header') {
    const matchId = record.matchId;
    if (typeof matchId !== 'string') return null;
    return {
      kind: 'header',
      atMs,
      clock,
      body: record.body ?? {},
      format: typeof record.format === 'number' ? record.format : 0,
      matchId,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      keyframeIntervalMs:
        typeof record.keyframeIntervalMs === 'number' ? record.keyframeIntervalMs : 0,
    };
  }

  if (kind === 'keyframe') {
    const state = asRecord(record.state);
    if (state === undefined) return null;
    return {
      kind: 'keyframe',
      atMs,
      clock,
      body: record.body ?? {},
      receivedAt: typeof record.receivedAt === 'number' ? record.receivedAt : atMs,
      version: typeof record.version === 'number' ? record.version : 0,
      reason: typeof record.reason === 'string' ? record.reason : 'unknown',
      state: state as unknown as SerialisedWorldState,
    };
  }

  if (!OBSERVATION_KINDS.includes(kind)) return null;

  const redacted = record.redacted === true;
  const base = {
    kind: kind as ObservationKind,
    atMs,
    clock,
    body: record.body ?? {},
    sourceId: typeof record.sourceId === 'string' ? record.sourceId : 'unknown',
    seq: typeof record.seq === 'number' ? record.seq : 0,
    receivedAt: typeof record.receivedAt === 'number' ? record.receivedAt : atMs,
    v: typeof record.v === 'number' ? record.v : 0,
  };
  // `exactOptionalPropertyTypes` is on: an absent flag has to be an absent property.
  return redacted ? { ...base, redacted: true } : base;
}

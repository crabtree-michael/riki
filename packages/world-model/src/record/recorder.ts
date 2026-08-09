/**
 * The recorder: every observation to disk as it happens, plus a keyframe every 30 s.
 *
 * The recording is the agent's memory (conversational-architecture.md §6), and that is a stronger
 * requirement than "a log". Three properties follow, and each one shapes the code below.
 *
 * **It must survive the process.** The old design lost a match's memory with the process, and
 * 2026-08-09's debugging session cost a morning for exactly the want of a recording. So there is no
 * buffer here: a line is handed to the sink and the sink writes it. `close()` is about the file
 * descriptor, not about flushing — by the time it is called there is nothing left to flush, which
 * is what makes a `SIGKILL` mid-match cost the half-written last line and nothing else.
 *
 * **It must not be able to take state capture down.** A recorder is a passenger on the 10 ms
 * fusion path. Every write is guarded, and a sink that throws ends the recording for that match
 * rather than propagating: a Riki that is watching without remembering is worth much more than one
 * that has stopped watching. The failure is reported, never swallowed.
 *
 * **It must stay a fixture.** See `format.ts` — the reason a keyframe carries `body: {}` is that
 * `tools/gsi-replay` has to be able to read a real recording.
 *
 * The `RecordSink` seam is what keeps all of this testable with no filesystem, and it is why
 * `file-sink.ts` is the only file in `packages/world-model` that does I/O.
 */

import type { Observation } from '../observation.js';
import type { WorldModelReader } from '../store.js';
import type { MonoMs } from '../time.js';
import { asRecord } from '../fusion/candidate.js';
import type { ObservationLine, RecordLine } from './format.js';
import { RECORD_FORMAT_VERSION, encodeRecordLine } from './format.js';
import { serialiseWorldState } from './keyframe.js';

/** conversational-architecture.md §6: "a full keyframe … is written every 30 seconds". */
export const DEFAULT_KEYFRAME_INTERVAL_MS = 30_000;

/**
 * Where lines go. One per match.
 *
 * `writeLine` is synchronous and unbuffered by contract, not by convention — an implementation
 * that queues would return this module to the "memory lost with the process" behaviour it exists
 * to fix, and nothing in the type would have changed.
 */
export interface RecordSink {
  writeLine(line: string): void;
  close(): void;
}

export type RecordSinkFactory = (matchId: string) => RecordSink;

export interface RecorderTelemetry {
  recordingOpened(matchId: string): void;
  recordingClosed(matchId: string, lines: number, keyframes: number): void;
  /** The sink refused a write. The recording for this match has stopped; the match has not. */
  recordingFailed(matchId: string, reason: string): void;
}

export interface MatchRecorderDeps {
  readonly openSink: RecordSinkFactory;
  /**
   * Read for two things: the game clock stamped on every line, and the state a keyframe is made
   * of. `snapshot()` is the store's own read view, so the recorder sees exactly what a coach would
   * — there is no second path into the model that could disagree with it.
   */
  readonly world: WorldModelReader;
  readonly keyframeIntervalMs?: number;
  readonly telemetry?: RecorderTelemetry;
}

export interface RecordStats {
  readonly lines: number;
  readonly keyframes: number;
  /** Observations that arrived with no recording open — between matches, or after a failure. */
  readonly unrecorded: number;
  readonly failures: number;
}

export interface MatchRecorder {
  /** Starts a recording. Writes the header and an opening keyframe. Closes any recording still open. */
  open(matchId: string, now: MonoMs): void;
  /** Appends one observation, and a keyframe if the interval has elapsed. */
  record(o: Observation, now: MonoMs): void;
  /** Forces a keyframe. The composition root calls this after a reset. */
  keyframe(now: MonoMs, reason: string): void;
  close(now: MonoMs, reason: string): void;
  readonly matchId: string | null;
  readonly stats: RecordStats;
}

export function createMatchRecorder(deps: MatchRecorderDeps): MatchRecorder {
  const interval = deps.keyframeIntervalMs ?? DEFAULT_KEYFRAME_INTERVAL_MS;
  const telemetry = deps.telemetry;

  let sink: RecordSink | null = null;
  let matchId: string | null = null;
  let startedAt: MonoMs = 0 as MonoMs;
  let lastKeyframeAt: MonoMs = 0 as MonoMs;
  let lines = 0;
  let keyframes = 0;
  let unrecorded = 0;
  let failures = 0;

  const atMs = (now: MonoMs): number => Math.max(0, now - startedAt);

  /** Drops the sink without writing anything more to it. Used on failure and by `close`. */
  const abandon = (): void => {
    const target = sink;
    sink = null;
    matchId = null;
    if (target === null) return;
    try {
      target.close();
    } catch {
      // Closing a descriptor that is already broken is not news, and there is nowhere left to
      // report it to — the recording is over either way.
      failures += 1;
    }
  };

  /**
   * The one place a line reaches the sink.
   *
   * A throwing sink is a full disk, a revoked permission or a closed descriptor. None of them get
   * better by retrying on the next observation, and all of them would otherwise throw once per
   * POST for the rest of the match — so the recording ends here, loudly, and the file keeps
   * whatever it already had.
   */
  const write = (line: RecordLine): boolean => {
    const target = sink;
    if (target === null) return false;
    try {
      target.writeLine(encodeRecordLine(line));
      lines += 1;
      return true;
    } catch (error) {
      failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      const failed = matchId ?? 'unknown';
      abandon();
      telemetry?.recordingFailed(failed, reason);
      return false;
    }
  };

  const clockOf = (now: MonoMs): number | null => deps.world.snapshot(now).clock;

  const writeKeyframe = (now: MonoMs, reason: string): void => {
    const snapshot = deps.world.snapshot(now);
    const ok = write({
      kind: 'keyframe',
      atMs: atMs(now),
      clock: snapshot.clock,
      body: {},
      receivedAt: now,
      version: snapshot.version,
      reason,
      state: serialiseWorldState(snapshot.state),
    });
    if (ok) keyframes += 1;
    lastKeyframeAt = now;
  };

  const closeRecording = (now: MonoMs, reason: string): void => {
    if (sink === null) return;
    const closing = matchId ?? 'unknown';
    // A closing keyframe means the end of a match is answerable without replaying from the last
    // interval boundary, which is where most of the questions land.
    writeKeyframe(now, reason);
    const total = lines;
    const frames = keyframes;
    abandon();
    telemetry?.recordingClosed(closing, total, frames);
  };

  return {
    open(id: string, now: MonoMs): void {
      closeRecording(now, 'superseded');

      try {
        sink = deps.openSink(id);
      } catch (error) {
        failures += 1;
        telemetry?.recordingFailed(id, error instanceof Error ? error.message : String(error));
        return;
      }

      matchId = id;
      startedAt = now;
      lastKeyframeAt = now;
      lines = 0;
      keyframes = 0;

      write({
        kind: 'header',
        atMs: 0,
        clock: clockOf(now),
        body: {},
        format: RECORD_FORMAT_VERSION,
        matchId: id,
        startedAt: now,
        keyframeIntervalMs: interval,
      });
      // The opening keyframe is the anchor `world_at` seeks back to for any question about the
      // first thirty seconds. Without it the earliest answerable instant is the first interval.
      writeKeyframe(now, 'open');
      telemetry?.recordingOpened(id);
    },

    record(o: Observation, now: MonoMs): void {
      if (sink === null) {
        unrecorded += 1;
        return;
      }

      const redacted = isChat(o);
      const base = {
        kind: o.kind,
        atMs: atMs(now),
        clock: clockOf(now),
        body: redacted ? withoutChatText(o.payload) : o.payload,
        sourceId: o.sourceId,
        seq: o.seq,
        receivedAt: o.receivedAt,
        v: o.v,
      };
      // `exactOptionalPropertyTypes` is on: an absent flag is an absent property, not `undefined`.
      const line: ObservationLine = redacted ? { ...base, redacted: true } : base;
      if (!write(line)) return;

      if (now - lastKeyframeAt >= interval) writeKeyframe(now, 'interval');
    },

    keyframe(now: MonoMs, reason: string): void {
      if (sink === null) return;
      writeKeyframe(now, reason);
    },

    close(now: MonoMs, reason: string): void {
      closeRecording(now, reason);
    },

    get matchId(): string | null {
      return matchId;
    },

    get stats(): RecordStats {
      return { lines, keyframes, unrecorded, failures };
    },
  };
}

/**
 * What goes on disk, minus the words that are not ours.
 *
 * dota2 §7 classes a chat line `sensitive` because it is somebody else's typing, and
 * `packages/log-tail` tags it at the source so that a sink cannot forget. This is a sink. The line
 * is still recorded — that somebody said something at this instant is a fact about the match, and
 * dropping it entirely would leave a hole in the timeline — but the text and the speaker do not
 * reach the file, and `redacted: true` says so on the line rather than leaving a reader to infer
 * it from an absence.
 *
 * ⚠ `player.steamid` in a GSI payload is **not** hashed here. dota2 §7 requires it and T10 of the
 * conversational migration owns it, along with the retention bound; this note is the seam it
 * lands on.
 */
function withoutChatText(payload: unknown): unknown {
  const record = asRecord(payload);
  if (record === undefined) return payload;

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'text' || key === 'speaker') continue;
    kept[key] = value;
  }
  return kept;
}

function isChat(o: Observation): boolean {
  return o.kind === 'log.event' && asRecord(o.payload)?.kind === 'chat';
}

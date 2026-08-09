/**
 * The only file in `packages/world-model` that touches a disk.
 *
 * The package header says "pure functions over data: no I/O", and that is still true of everything
 * else — the recorder, the line format and the keyframe encoder are all pure over an injected
 * `RecordSink`. This file is the exception the recorder was given a seam for, and it is here
 * rather than in the composition root because three consumers need the same bytes: the app, the
 * timeline reader that answers `world_at`, and `tools/`. A second implementation in `tools/` would
 * be a second answer to "how is a recording written", which is exactly what the seam exists to
 * prevent. See ADR-0044.
 *
 * ## Why `writeSync` and not a stream
 *
 * The requirement is that a killed process leaves a file that still parses to its last complete
 * line. A `WriteStream` buffers in userspace, so a `SIGKILL` discards whatever had not drained —
 * which for a 2–8 Hz recording is usually the last second or two of the match, and always the part
 * someone is asking about. `writeSync` hands the bytes to the kernel before returning, so only a
 * machine crash can lose them, and a `SIGKILL` costs at most a half-written line.
 *
 * The write loop matters for the same reason: `writeSync` may write fewer bytes than it was given,
 * and a line silently cut in half in the *middle* of a recording is corruption a reader cannot
 * distinguish from a crash.
 *
 * `O_APPEND` (the `'a'` flag) rather than a tracked offset: reopening an existing recording after a
 * restart mid-match then continues the file rather than overwriting it.
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { RecordSink, RecordSinkFactory } from './recorder.js';

export const RECORD_FILE_EXTENSION = '.jsonl';

/**
 * A file name for a match id.
 *
 * The match id arrives from `map.matchid` in a GSI POST — that is, from outside the process — and
 * is interpolated into a path. Anything but the characters Valve actually uses is replaced, so a
 * hostile or merely surprising id cannot escape the directory. Empty after that is `unknown`,
 * because a file called `.jsonl` is worse than a wrong name.
 */
export function matchFileName(matchId: string): string {
  const safe = matchId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `${safe === '' ? 'unknown' : safe}${RECORD_FILE_EXTENSION}`;
}

/**
 * Sinks that append to `<directory>/<matchId>.jsonl`.
 *
 * The directory is created on first use rather than on construction: the composition root wires
 * this at startup, and a Riki that has never seen a match should not have created a `matches/`
 * directory in the user's Application Support folder.
 */
export function createFileRecordSinks(directory: string): RecordSinkFactory {
  return (matchId: string): RecordSink => {
    mkdirSync(directory, { recursive: true });
    const fd = openSync(join(directory, matchFileName(matchId)), 'a');
    let closed = false;

    return {
      writeLine(line: string): void {
        const buffer = Buffer.from(`${line}\n`, 'utf8');
        let written = 0;
        while (written < buffer.length) {
          written += writeSync(fd, buffer, written, buffer.length - written);
        }
      },

      close(): void {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    };
  };
}

/**
 * The one file in this package that touches a disk, tested against a real one.
 *
 * The requirement is "a killed process leaves a file that still parses to the last complete line",
 * and it decomposes into two claims that *are* testable without killing anything:
 *
 * 1. **A line is on the filesystem before `writeLine` returns.** That is what rules out a
 *    userspace buffer, and it is the difference between losing the last line and losing the last
 *    few seconds. Asserted by reading the file back with the sink still open.
 * 2. **A file cut at an arbitrary byte still parses to its last complete line.** Asserted by
 *    truncating a real recording, which is the shape a `SIGKILL` leaves once (1) holds.
 *
 * Together those are the property. What no test here can show is that the *kernel* flushed to the
 * platter — that is a machine crash rather than a process crash, and `writeSync` is where this
 * design stops.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileRecordSinks, matchFileName } from './file-sink.js';
import { parseRecordLines } from './format.js';

let directory = '';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'riki-record-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A recording's worth of well-formed lines, without dragging the recorder into this file. */
function line(index: number): string {
  return JSON.stringify({
    atMs: index * 250,
    kind: 'gsi.payload',
    clock: 600 + index,
    body: { map: { clock_time: 600 + index } },
    sourceId: 'gsi',
    seq: index,
    receivedAt: index * 250,
    v: 1,
  });
}

describe('the file sink', () => {
  it('names the file after the match, under matches/', () => {
    const sinks = createFileRecordSinks(join(directory, 'matches'));
    const sink = sinks('7891234567');
    sink.writeLine(line(0));
    sink.close();

    const path = join(directory, 'matches', matchFileName('7891234567'));
    expect(statSync(path).isFile()).toBe(true);
  });

  it('does not create the directory until a match is actually recorded', () => {
    createFileRecordSinks(join(directory, 'matches'));

    expect(() => statSync(join(directory, 'matches'))).toThrow();
  });

  it('has the line on disk before writeLine returns — no buffer to lose', () => {
    const sinks = createFileRecordSinks(directory);
    const sink = sinks('m');
    sink.writeLine(line(0));
    sink.writeLine(line(1));

    // Read with the descriptor still open. A WriteStream would have nothing here yet, which is
    // exactly the failure this sink exists to avoid.
    const onDisk = readFileSync(join(directory, matchFileName('m')), 'utf8');
    expect(parseRecordLines(onDisk).lines).toHaveLength(2);

    sink.close();
  });

  it('appends when a recording is reopened, so a restart mid-match does not lose the first half', () => {
    const sinks = createFileRecordSinks(directory);
    const first = sinks('m');
    first.writeLine(line(0));
    first.close();

    const second = sinks('m');
    second.writeLine(line(1));
    second.close();

    const onDisk = readFileSync(join(directory, matchFileName('m')), 'utf8');
    expect(parseRecordLines(onDisk).lines).toHaveLength(2);
  });

  it('still parses to the last complete line after the file is cut mid-line', () => {
    const sinks = createFileRecordSinks(directory);
    const sink = sinks('m');
    for (let index = 0; index < 5; index += 1) sink.writeLine(line(index));
    sink.close();

    const path = join(directory, matchFileName('m'));
    const whole = parseRecordLines(readFileSync(path, 'utf8'));
    expect(whole.lines).toHaveLength(5);

    // Somewhere in the middle of the last line, which is where a kill lands.
    truncateSync(path, statSync(path).size - 30);

    const partial = parseRecordLines(readFileSync(path, 'utf8'));
    expect(partial.truncated).toBe(true);
    expect(partial.malformed).toBe(0);
    expect(partial.lines).toHaveLength(4);
    expect(partial.lines.at(-1)).toEqual(whole.lines[3]);
  });

  it('closes idempotently, because shutdown and match_ended can both arrive', () => {
    const sink = createFileRecordSinks(directory)('m');
    sink.writeLine(line(0));
    sink.close();

    expect(() => {
      sink.close();
    }).not.toThrow();
  });
});

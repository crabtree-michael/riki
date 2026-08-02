/**
 * The sidecar supervisor, against a fake process.
 *
 * `crates/riki-vision` is an empty `main()`, so there is nothing to spawn that would prove
 * anything — and that is precisely why the process is behind a port. Every failure mode a real
 * sidecar has (crash, missing binary, a partial line across a chunk boundary, a SIGTERM it
 * ignores) is reproducible here in three lines and in microseconds.
 */

import { describe, expect, it, vi } from 'vitest';
import type { MonoMs, Observation, SourceId } from '@riki/world-model';
import { NULL_CODEC, SIDECAR_QUIET_MS, createSidecarSource } from './index.js';
import type { ChildProcessHandle, ChildProcessPort, SidecarCodec } from './contracts.js';
import { lines } from './node-process.js';

interface FakeProcess extends ChildProcessHandle {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  exit(reason: string): void;
  readonly written: readonly string[];
  readonly killed: boolean;
}

function fakeProcess(): FakeProcess {
  const out = new Set<(line: string) => void>();
  const err = new Set<(line: string) => void>();
  const exits = new Set<(reason: string) => void>();
  const written: string[] = [];
  let killed = false;

  return {
    written,
    get killed() {
      return killed;
    },
    onStdout: (fn) => {
      out.add(fn);
      return () => out.delete(fn);
    },
    onStderr: (fn) => {
      err.add(fn);
      return () => err.delete(fn);
    },
    onExit: (fn) => {
      exits.add(fn);
      return () => exits.delete(fn);
    },
    write: (line) => void written.push(line),
    kill: () => {
      killed = true;
      return Promise.resolve();
    },
    stdout: (chunk) => {
      for (const fn of [...out]) fn(chunk);
    },
    stderr: (chunk) => {
      for (const fn of [...err]) fn(chunk);
    },
    exit: (reason) => {
      for (const fn of [...exits]) fn(reason);
    },
  };
}

function fakePort(child: FakeProcess): ChildProcessPort {
  return { spawn: () => child };
}

const REQUEST = { command: '/usr/local/bin/riki-vision', args: [] };

describe('the sidecar as a source', () => {
  it('announces an exit so the supervisor above it can decide, rather than restarting itself', async () => {
    const child = fakeProcess();
    const source = createSidecarSource({
      processes: fakePort(child),
      request: REQUEST,
      now: () => 0 as MonoMs,
    });

    const exits: string[] = [];
    source.onExit((reason) => exits.push(reason));
    await source.start();
    child.exit('exited with code 101');

    // Two restart loops for one process is how a fork bomb happens; the policy lives in one place.
    expect(exits).toEqual(['exited with code 101']);
    expect(source.stats().exits).toBe(1);
  });

  it('does not report a deliberate stop as a crash', async () => {
    const child = fakeProcess();
    const source = createSidecarSource({
      processes: fakePort(child),
      request: REQUEST,
      now: () => 0 as MonoMs,
    });

    const exits: string[] = [];
    source.onExit((reason) => exits.push(reason));
    await source.start();
    await source.stop();
    // The kill fires the real process's `exit`; nothing should be listening by then, or the
    // supervisor would restart something we are shutting down.
    child.exit('killed by SIGTERM');

    expect(child.killed).toBe(true);
    expect(exits).toEqual([]);
  });

  it('counts a line it cannot decode instead of throwing on it', async () => {
    const child = fakeProcess();
    const source = createSidecarSource({
      processes: fakePort(child),
      request: REQUEST,
      now: () => 0 as MonoMs,
      codec: NULL_CODEC,
    });

    await source.start();
    child.stdout('thread panicked at src/main.rs:12');

    expect(source.stats().linesIn).toBe(1);
    // Talking-and-not-understood is a different problem from silent, and the counters are the
    // only thing that tells them apart while there is no protocol.
    expect(source.stats().linesUndecodable).toBe(1);
  });

  it('publishes what the codec decodes, with a per-source sequence', async () => {
    const child = fakeProcess();
    const codec: SidecarCodec = {
      hello: () => ['{"hello":1}'],
      decode: (line, at, seq) => ({
        kind: 'observation',
        observation: {
          kind: 'cv.detections',
          sourceId: 'sidecar' as SourceId,
          seq,
          receivedAt: at,
          payload: JSON.parse(line),
          v: 1,
        },
      }),
    };

    const child2 = child;
    const source = createSidecarSource({
      processes: fakePort(child2),
      request: REQUEST,
      now: () => 100 as MonoMs,
      codec,
    });

    const seen: Observation[] = [];
    source.subscribe((o) => seen.push(o));
    await source.start();

    expect(child2.written).toEqual(['{"hello":1}']);
    child2.stdout('{"a":1}');
    child2.stdout('{"a":2}');

    expect(seen.map((o) => o.seq)).toEqual([0, 1]);
  });

  it('does not let a handled line pass for a detection', async () => {
    // A `ready` is understood and is not a fact. If it moved `lastObservationAt`, a sidecar whose
    // only output was its handshake would report `live` — which is exactly the failure this
    // source exists to catch.
    const child = fakeProcess();
    const source = createSidecarSource({
      processes: fakePort(child),
      request: REQUEST,
      now: () => 0 as MonoMs,
      codec: { hello: () => [], decode: () => ({ kind: 'handled' }) },
    });

    const seen: Observation[] = [];
    source.subscribe((o) => seen.push(o));
    await source.start();
    child.stdout('{"v":1,"type":"ready"}');

    expect(seen).toEqual([]);
    expect(source.stats().linesHandled).toBe(1);
    expect(source.stats().linesUndecodable).toBe(0);
    expect(source.health(0 as MonoMs).lastObservationAt).toBeNull();
  });

  it('reports a running-but-silent sidecar as degraded, not as still starting', async () => {
    const child = fakeProcess();
    let now = 0;
    const source = createSidecarSource({
      processes: fakePort(child),
      request: REQUEST,
      now: () => now as MonoMs,
    });

    await source.start();
    expect(source.health(now as MonoMs).state).toBe('starting');

    now = SIDECAR_QUIET_MS + 1;
    // A process that never speaks is a real failure and must not sit in `starting` forever
    // looking like a slow boot.
    expect(source.health(now as MonoMs).state).toBe('degraded');
  });

  it('propagates a spawn failure so the supervisor takes the same backoff path as a crash', async () => {
    const source = createSidecarSource({
      processes: {
        spawn: () => {
          throw new Error('spawn ENOENT');
        },
      },
      request: REQUEST,
      now: () => 0 as MonoMs,
    });

    await expect(source.start()).rejects.toThrow('ENOENT');
  });

  it('forwards stderr, which is where a panic trace arrives', async () => {
    const child = fakeProcess();
    const onStderr = vi.fn();
    const source = createSidecarSource({
      processes: fakePort(child),
      request: REQUEST,
      now: () => 0 as MonoMs,
      onStderr,
    });

    await source.start();
    child.stderr('note: run with `RUST_BACKTRACE=1`');
    expect(onStderr).toHaveBeenCalledWith('note: run with `RUST_BACKTRACE=1`');
  });
});

// -------------------------------------------------------------------------------------------

describe('line buffering', () => {
  /** A chunk from a pipe is not a line, and the failure mode is load-dependent. */
  function collect(chunks: readonly string[]): readonly string[] {
    const handlers = new Set<(chunk: Buffer | string) => void>();
    const stream = {
      on: (_event: string, fn: (chunk: Buffer | string) => void) => void handlers.add(fn),
      off: (_event: string, fn: (chunk: Buffer | string) => void) => void handlers.delete(fn),
    } as unknown as NodeJS.ReadableStream;

    const seen: string[] = [];
    lines(stream, (line) => seen.push(line));
    for (const chunk of chunks) for (const fn of [...handlers]) fn(chunk);
    return seen;
  }

  it('joins a message split across two chunks', () => {
    expect(collect(['{"a":', '1}\n'])).toEqual(['{"a":1}']);
  });

  it('splits two messages arriving in one chunk', () => {
    expect(collect(['one\ntwo\n'])).toEqual(['one', 'two']);
  });

  it('holds a trailing partial rather than delivering half a message', () => {
    expect(collect(['whole\npart'])).toEqual(['whole']);
  });

  it('strips a carriage return, so a Windows sidecar is not a protocol error', () => {
    expect(collect(['one\r\n'])).toEqual(['one']);
  });

  it('drops blank lines rather than handing the codec nothing to decode', () => {
    expect(collect(['\n\nvalue\n'])).toEqual(['value']);
  });
});

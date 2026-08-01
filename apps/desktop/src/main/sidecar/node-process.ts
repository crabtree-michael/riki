/**
 * The one file that imports `node:child_process`.
 *
 * Three things here are easy to get wrong and are the reason this is not inlined into
 * `index.ts`:
 *
 * - **Line buffering.** A chunk from a pipe is not a line. Splitting each chunk on `\n` and
 *   forwarding the pieces delivers half-messages that a codec then rejects as malformed, which
 *   reads in the counters exactly like a protocol-version mismatch. The trailing partial is held.
 * - **`spawn` failure is asynchronous.** A missing binary does not throw from `spawn`; it emits
 *   `error` on the next tick. A supervisor that only listens for `exit` waits forever for a
 *   process that was never created, so `error` is routed to the same listener set as `exit`.
 * - **SIGTERM is a request.** A sidecar mid-capture may not answer it, and Electron will not quit
 *   while a child holds the event loop. `kill()` escalates to SIGKILL after a grace period and
 *   resolves either way, so app shutdown is bounded.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessHandle, ChildProcessPort, SpawnRequest } from './contracts.js';

/** Long enough for a clean capture teardown, short enough not to hang a quit. */
export const KILL_GRACE_MS = 2_000;

export interface NodeChildProcessOptions {
  readonly killGraceMs?: number;
}

export function createNodeChildProcessPort(
  options: NodeChildProcessOptions = {},
): ChildProcessPort {
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  return {
    spawn(request: SpawnRequest): ChildProcessHandle {
      const child = spawn(request.command, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        stdio: ['pipe', 'pipe', 'pipe'],
        // No shell: the path comes from config and a shell would make it an injection surface for
        // free, in the one process that holds the API key.
        shell: false,
        // Nothing about the sidecar should keep Electron alive. If it is the last handle, we are
        // quitting anyway and `kill()` is about to run.
        detached: false,
      });

      const exitListeners = new Set<(reason: string) => void>();
      let exited = false;

      const announceExit = (reason: string): void => {
        if (exited) return;
        exited = true;
        for (const listener of [...exitListeners]) listener(reason);
      };

      child.on('error', (error: Error) => {
        announceExit(error.message);
      });
      child.on('exit', (code, signal) => {
        announceExit(
          signal !== null ? `killed by ${signal}` : `exited with code ${String(code ?? 'unknown')}`,
        );
      });

      return {
        onStdout(listener) {
          return lines(child.stdout, listener);
        },
        onStderr(listener) {
          return lines(child.stderr, listener);
        },
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        write(line: string) {
          if (!exited && child.stdin.writable) child.stdin.write(`${line}\n`);
        },
        kill(): Promise<void> {
          if (exited) return Promise.resolve();
          return new Promise<void>((resolve) => {
            const escalate = setTimeout(() => {
              child.kill('SIGKILL');
            }, killGraceMs);
            if (typeof escalate === 'object' && 'unref' in escalate) escalate.unref();

            child.once('exit', () => {
              clearTimeout(escalate);
              resolve();
            });
            child.kill('SIGTERM');
          });
        },
      };
    },
  };
}

/**
 * Chunks → whole lines, with the trailing partial held until the next chunk.
 *
 * Exported for its own test: this is the piece whose failure mode is silent corruption of every
 * message that happens to straddle a chunk boundary, which is load-dependent and therefore
 * unreproducible by hand.
 */
export function lines(
  stream: NodeJS.ReadableStream | null,
  listener: (line: string) => void,
): () => void {
  if (stream === null) return () => undefined;

  let buffer = '';
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line !== '') listener(line);
    }
  };

  stream.on('data', onData);
  return () => {
    stream.off('data', onData);
  };
}

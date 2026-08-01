/**
 * Following `console.log`.
 *
 * The whole job is the boring part, stated in §4.2: **the file you opened is not the file being
 * written to ten minutes later.** Four cases, and each one has a way of failing that looks like
 * success:
 *
 * 1. **Rotation.** The path now points at a new inode. Keeping the old handle means a tailer that
 *    reports perfect health and has not seen a line since the rotation.
 * 2. **Truncation.** Same inode, size went backwards. Reading from the old offset yields either
 *    nothing or the middle of a line.
 * 3. **A partial trailing line.** A poll can land mid-write. The tail of the buffer is held back
 *    until a newline arrives, because half a chat line parses as a whole one.
 * 4. **Starting mid-match.** Seek to the end. Replaying an hour of history at startup would flood
 *    the model with chat from a match that is already over.
 *
 * **Polling, not `fs.watch`.** `pollMs` is 250 by default. `fs.watch` semantics differ across all
 * three target platforms and are especially unreliable for the case that matters here — a file
 * being replaced rather than modified — so a stat every quarter second buys correctness for a
 * cost that does not register next to a game.
 */

import { open, stat } from 'node:fs/promises';
import type {
  ConsoleLogTailer,
  ConsoleLogTailerOptions,
  GameClock,
  LineMatcher,
  LogEvent,
  MonoMs,
  Observation,
  SourceHealth,
  SourceId,
  Unsubscribe,
} from './contracts.js';
import { matchLine } from './matchers/index.js';

export const DEFAULT_POLL_MS = 250;
export const PROTOCOL_VERSION = 1;

/**
 * How long without a line before the tailer calls itself degraded.
 *
 * Long, deliberately: `console.log` is genuinely silent for minutes at a time in a quiet match,
 * so unlike GSI there is no heartbeat to distinguish "nothing happened" from "gone". Silence here
 * is weak evidence and the threshold says so.
 */
export const QUIET_THRESHOLD_MS = 300_000;

export interface ConsoleLogTailerExtras {
  /**
   * Runs one poll cycle and returns how many events it published.
   *
   * Exposed so a test can drive the tailer deterministically instead of sleeping past a timer —
   * the same reason `FakeGsiSource` has `step()`. Every rotation and truncation test in this
   * package is a temp file plus a call to this.
   */
  poll(): Promise<number>;
  /** Where the tailer will read from next. Byte offset into the current inode. */
  readonly offset: number;
  stats(): ConsoleLogTailerStats;
}

export interface ConsoleLogTailerStats {
  readonly linesRead: number;
  readonly eventsPublished: number;
  readonly rotations: number;
  readonly truncations: number;
  readonly readErrors: number;
}

export interface ExtendedTailerOptions extends ConsoleLogTailerOptions {
  /**
   * Read the file from the beginning instead of seeking to the end. False in production — see
   * case 4 above — and true in tests and in `pnpm dev:replay`, where the fixture *is* the history.
   */
  readonly fromStart?: boolean;
  readonly sourceId?: string;
  /** Supplies the match clock for a line's timestamp. Null when the match has none. */
  readonly gameClock?: () => GameClock | null;
}

export type ConsoleLogTailerWithExtras = ConsoleLogTailer & ConsoleLogTailerExtras;

export function createConsoleLogTailer(opts: ExtendedTailerOptions): ConsoleLogTailerWithExtras {
  const id = (opts.sourceId ?? 'log-tail') as SourceId;
  const matchers: readonly LineMatcher[] = opts.matchers;
  const pollMs = opts.pollMs > 0 ? opts.pollMs : DEFAULT_POLL_MS;
  const gameClock = opts.gameClock ?? ((): GameClock | null => null);

  const listeners = new Set<(o: Observation) => void>();
  const stats = {
    linesRead: 0,
    eventsPublished: 0,
    rotations: 0,
    truncations: 0,
    readErrors: 0,
  };

  let offset = 0;
  let inode: number | null = null;
  /** The partial trailing line, held back until its newline arrives. */
  let pending = '';
  let seq = 0;
  let lastEventAt: MonoMs | null = null;
  let startedAt: MonoMs | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const publish = (event: LogEvent, receivedAt: MonoMs): void => {
    const observation: Observation = {
      kind: 'log.event',
      sourceId: id,
      seq: seq++,
      receivedAt,
      payload: event,
      v: PROTOCOL_VERSION,
    };
    lastEventAt = receivedAt;
    stats.eventsPublished += 1;
    for (const listener of listeners) listener(observation);
  };

  const consume = (chunk: string, receivedAt: MonoMs): number => {
    pending += chunk;
    const parts = pending.split('\n');
    // The last element is either empty (the chunk ended on a newline) or a partial line. Either
    // way it goes back into `pending` rather than to a matcher: half a chat line parses as a
    // whole one, and the whole one is wrong.
    pending = parts.pop() ?? '';

    let published = 0;
    const at = { observedAt: receivedAt, atGameClock: gameClock() };
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (line === '') continue;
      stats.linesRead += 1;
      const event = matchLine(matchers, line, at);
      if (event !== null) {
        publish(event, receivedAt);
        published += 1;
      }
    }
    return published;
  };

  const pollOnce = async (): Promise<number> => {
    let info;
    try {
      info = await stat(opts.path);
    } catch {
      // The file is missing — mid-rotation, or Dota has not been launched with `-condebug` yet.
      // Not an error to report: the next poll is the retry, and there is nothing else to do.
      return 0;
    }

    if (inode === null) {
      inode = info.ino;
      offset = opts.fromStart === true ? 0 : info.size;
    } else if (info.ino !== inode) {
      // Rotation. The bytes still in the old inode are gone as far as we are concerned: reopening
      // it to drain the tail would mean holding two handles and interleaving two files' lines out
      // of order, for a few lines at a boundary nobody is reading closely.
      inode = info.ino;
      offset = 0;
      pending = '';
      stats.rotations += 1;
    } else if (info.size < offset) {
      // Truncation: same file, fewer bytes. Reading on from the old offset yields the middle of
      // whatever was written next.
      offset = 0;
      pending = '';
      stats.truncations += 1;
    }

    if (info.size <= offset) return 0;

    const receivedAt = opts.clock.now();
    const length = info.size - offset;
    const buffer = Buffer.allocUnsafe(length);

    let bytesRead = 0;
    try {
      const handle = await open(opts.path, 'r');
      try {
        ({ bytesRead } = await handle.read(buffer, 0, length, offset));
      } finally {
        await handle.close();
      }
    } catch {
      stats.readErrors += 1;
      return 0;
    }

    offset += bytesRead;
    return consume(buffer.subarray(0, bytesRead).toString('utf8'), receivedAt);
  };

  const schedule = (): void => {
    if (!running) return;
    timer = setTimeout(() => {
      void pollOnce().finally(schedule);
    }, pollMs);
  };

  return {
    id,

    async start(): Promise<void> {
      if (running) return;
      running = true;
      startedAt = opts.clock.now();
      // One synchronous-ish pass first so that `offset` is anchored before the first tick; without
      // it a file that rotates between `start()` and the first poll looks like a fresh start.
      await pollOnce();
      schedule();
    },

    async stop(): Promise<void> {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return Promise.resolve();
    },

    subscribe(listener: (o: Observation) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Silence is only weakly informative here, so `down` is never reported from quietness alone —
     * only from never having started. Reporting a quiet log as down would have the supervisor
     * restarting a perfectly healthy tailer during every long farming phase.
     */
    health(now: MonoMs): SourceHealth {
      if (!running || startedAt === null) {
        return { state: 'down', lastObservationAt: lastEventAt, reason: 'Not started.' };
      }
      if (inode === null) {
        return {
          state: 'starting',
          lastObservationAt: null,
          reason: 'Waiting for console.log — is Dota 2 running with -condebug?',
        };
      }
      const since = lastEventAt ?? startedAt;
      if (now - since > QUIET_THRESHOLD_MS) {
        return {
          state: 'degraded',
          lastObservationAt: lastEventAt,
          reason: 'No console.log activity for several minutes.',
        };
      }
      return { state: 'live', lastObservationAt: lastEventAt };
    },

    poll(): Promise<number> {
      return pollOnce();
    },

    get offset(): number {
      return offset;
    },

    stats(): ConsoleLogTailerStats {
      return { ...stats };
    },
  };
}

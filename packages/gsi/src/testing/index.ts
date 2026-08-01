/**
 * Shared fakes for @riki/gsi, exported as `@riki/gsi/testing`.
 *
 * These are not test scaffolding: `pnpm dev:replay` drives the whole app through the same
 * fakes, which is what keeps them honest (REPO_SKELETON.md §5.2). No test may require a
 * running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * `FakeGsiSource` satisfies the same interface as `GsiServer`, so a consumer wired to it is wired
 * to the real thing. What it deliberately does *not* fake is the HTTP layer — auth, the body
 * limit and the 403 path are tested against a real socket in `server.test.ts`, because a fake of
 * those would only ever agree with itself.
 */

import { readFileSync } from 'node:fs';
import { createGameClockEstimator } from '../clock.js';
import type {
  Clock,
  GameClock,
  MonoMs,
  Observation,
  SourceHealth,
  SourceId,
  Unsubscribe,
} from '../contracts.js';
import { createGsiLiveness } from '../liveness.js';
import { createGsiPayloadParser } from '../parse.js';
import { PROTOCOL_VERSION } from '../server.js';

/**
 * One line of a `fixtures/gsi/*.jsonl` recording.
 *
 * `atMs` is milliseconds from the start of the recording rather than a wall clock: a fixture
 * carrying absolute timestamps would replay differently depending on when it was recorded, and
 * the point of a fixture is that it replays identically everywhere.
 */
export interface GsiFixtureLine {
  readonly atMs: number;
  readonly body: unknown;
}

export interface FakeGsiSourceOptions {
  readonly lines: readonly GsiFixtureLine[];
  readonly clock: Clock;
  /**
   * How much faster than real time to replay. `0` means "only when the caller says", which is
   * what a unit test wants — a test that waits out a recorded 30 s heartbeat is a test nobody
   * runs.
   */
  readonly speed?: number;
  readonly sourceId?: string;
}

export interface FakeGsiSource {
  readonly id: SourceId;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (o: Observation) => void): Unsubscribe;
  health(now: MonoMs): SourceHealth;
  readonly address: { readonly port: number } | null;

  /** Emits the next recorded POST; false once the recording is exhausted. */
  step(): boolean;
  /** Emits everything remaining, ignoring the recorded timing. */
  drain(): number;
  estimateClock(now: MonoMs): GameClock | null;
  readonly remaining: number;
}

export function loadGsiFixture(path: string): readonly GsiFixtureLine[] {
  return parseGsiFixture(readFileSync(path, 'utf8'));
}

/**
 * Blank lines and `//` lines are skipped, so a recording can carry a header explaining where it
 * came from — which matters more than usual here, because a synthesised fixture and a captured
 * one look identical and are worth very different amounts.
 */
export function parseGsiFixture(contents: string): readonly GsiFixtureLine[] {
  return contents
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('//'))
    .map((line, index): GsiFixtureLine => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const atMs = parsed.atMs;
      return {
        atMs: typeof atMs === 'number' ? atMs : index * 250,
        body: parsed.body ?? parsed,
      };
    });
}

export function createFakeGsiSource(opts: FakeGsiSourceOptions): FakeGsiSource {
  const id = (opts.sourceId ?? 'fake-gsi') as SourceId;
  const parser = createGsiPayloadParser();
  const liveness = createGsiLiveness();
  const estimator = createGameClockEstimator();
  const listeners = new Set<(o: Observation) => void>();

  let index = 0;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const speed = opts.speed ?? 0;

  const emit = (): boolean => {
    const line = opts.lines[index];
    if (line === undefined) return false;
    index += 1;

    const parsed = parser.parse(line.body);
    if (!parsed.ok) return true; // A deliberately malformed fixture line is still a step.

    const receivedAt = opts.clock.now();
    liveness.noteObservation(receivedAt);
    const map = parsed.value.map;
    if (map?.clock_time !== undefined) {
      estimator.update(map.clock_time as GameClock, receivedAt, map.paused ?? false);
    }

    const observation: Observation = {
      kind: 'gsi.payload',
      sourceId: id,
      seq: seq++,
      receivedAt,
      payload: parsed.value,
      v: PROTOCOL_VERSION,
    };
    for (const listener of listeners) listener(observation);
    return true;
  };

  const scheduleNext = (): void => {
    if (speed <= 0) return;
    const current = opts.lines[index];
    if (current === undefined) return;
    const previous = index === 0 ? undefined : opts.lines[index - 1];
    const gap = previous === undefined ? 0 : Math.max(0, current.atMs - previous.atMs);

    timer = setTimeout(() => {
      emit();
      scheduleNext();
    }, gap / speed);
  };

  return {
    id,

    start(): Promise<void> {
      scheduleNext();
      return Promise.resolve();
    },

    stop(): Promise<void> {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return Promise.resolve();
    },

    subscribe(listener: (o: Observation) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    health(now: MonoMs): SourceHealth {
      const { state, sinceLastMs } = liveness.check(now);
      return {
        state,
        lastObservationAt: state === 'starting' ? null : ((now - sinceLastMs) as MonoMs),
      };
    },

    address: null,

    step(): boolean {
      return emit();
    },

    drain(): number {
      let count = 0;
      while (emit()) count += 1;
      return count;
    },

    estimateClock(now: MonoMs): GameClock | null {
      return estimator.estimate(now);
    },

    get remaining(): number {
      return Math.max(0, opts.lines.length - index);
    },
  };
}

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/**
 * A clock a test drives by hand.
 *
 * `packages/world-model` never needs one — time arrives there as a parameter — but a *source*
 * genuinely has to read a clock, so this is where the injectable-clock discipline earns its keep.
 */
export function createManualClock(start = 0): ManualClock {
  let now = start;
  return {
    now: (): MonoMs => now as MonoMs,
    advance(ms: number): void {
      now += ms;
    },
    set(ms: number): void {
      now = ms;
    },
  };
}

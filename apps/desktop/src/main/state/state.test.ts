/**
 * The three decisions in `main/state/`, each asserted where it is made.
 *
 * None of these needs Dota, a socket or a child process — which is the point of the subsystem
 * taking its sources by injection. What is tested here is *supervision and shedding policy*; that
 * the world model fuses correctly is `packages/world-model`'s, and that a GSI POST parses is
 * `packages/gsi`'s.
 */

import { describe, expect, it } from 'vitest';
import type { Timers } from '@riki/context';
import type { MonoMs, Observation, SourceHealth, SourceId } from '@riki/world-model';

import { createObservationBus } from './bus.js';
import { createSourceSupervisor, type ExitingSource } from './supervisor.js';
import { createDegradationController, RECOVERY_HYSTERESIS_MS } from './degradation.js';
import { buildStateSubsystem } from './index.js';
import { NO_RESTART, SIDECAR_RESTART, type SourceStatus } from './contracts.js';

// -------------------------------------------------------------------------------------------

/** Timers a test fires by hand, in due order. */
function manualTimers(): Timers & { advance(): boolean; readonly depth: number } {
  const pending: { fn: () => void }[] = [];
  return {
    after(_ms, fn) {
      const entry = { fn };
      pending.push(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
      };
    },
    advance() {
      const next = pending.shift();
      if (next === undefined) return false;
      next.fn();
      return true;
    },
    get depth() {
      return pending.length;
    },
  };
}

function observation(kind: Observation['kind'], sourceId: string, seq: number): Observation {
  return {
    kind,
    sourceId: sourceId as SourceId,
    seq,
    receivedAt: 0 as MonoMs,
    payload: {},
    v: 1,
  };
}

// -------------------------------------------------------------------------------------------

describe('the observation bus (§6.3)', () => {
  it('delivers synchronously, because fusion is on the 10 ms path and a queue buys nothing', () => {
    const bus = createObservationBus();
    const seen: number[] = [];
    bus.subscribe((o) => seen.push(o.seq));

    bus.publish(observation('gsi.payload', 'gsi', 0));
    expect(seen).toEqual([0]);
  });

  it('counts a sequence gap without treating it as fatal', () => {
    const bus = createObservationBus();
    bus.subscribe(() => undefined);

    bus.publish(observation('gsi.payload', 'gsi', 0));
    bus.publish(observation('gsi.payload', 'gsi', 1));
    // A gap, then a reorder. Precedence rule 3 rejects a late observation per field, so both are
    // counted and both are delivered.
    bus.publish(observation('gsi.payload', 'gsi', 5));
    bus.publish(observation('gsi.payload', 'gsi', 4));

    expect(bus.stats().gaps.get('gsi')).toBe(2);
  });

  it('keeps per-source sequence counters apart', () => {
    const bus = createObservationBus();
    bus.subscribe(() => undefined);

    bus.publish(observation('gsi.payload', 'gsi', 0));
    bus.publish(observation('cv.detections', 'sidecar', 0));
    bus.publish(observation('gsi.payload', 'gsi', 1));
    bus.publish(observation('cv.detections', 'sidecar', 1));

    expect(bus.stats().gaps.size).toBe(0);
  });

  it('sheds the oldest CV batch when a re-entrant subscriber floods the queue', () => {
    const bus = createObservationBus({ bound: 2 });
    let burst = false;

    bus.subscribe(() => {
      // A subscriber that publishes while being delivered to. The queue exists so this does not
      // recurse; the bound exists so a burst cannot grow it without limit. One re-publish per
      // delivery never reaches the bound — the drain shifts before the subscriber pushes — so the
      // case worth asserting is the one that does.
      if (burst) return;
      burst = true;
      for (let index = 1; index <= 8; index += 1) {
        bus.publish(observation('cv.detections', 'sidecar', index));
      }
    });

    bus.publish(observation('cv.detections', 'sidecar', 0));
    const dropped = bus.stats().dropped.get('cv.detections') ?? 0;
    expect(dropped).toBeGreaterThan(0);
  });

  it('never sheds a GSI observation, whatever the queue depth', () => {
    const bus = createObservationBus({ bound: 1 });
    let burst = false;
    const seen: number[] = [];

    bus.subscribe((o) => {
      if (o.kind === 'gsi.payload') seen.push(o.seq);
      if (burst) return;
      burst = true;
      for (let index = 1; index <= 8; index += 1) {
        bus.publish(observation('gsi.payload', 'gsi', index));
      }
    });

    bus.publish(observation('gsi.payload', 'gsi', 0));
    // Low rate, authoritative, and each one carries information nothing else carries (§6.3).
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(bus.stats().dropped.size).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------

interface FakeSource extends ExitingSource {
  readonly starts: number;
  crash(reason: string): void;
  failNextStart(message: string): void;
}

function fakeSource(id: string): FakeSource {
  const exits = new Set<(reason: string) => void>();
  let starts = 0;
  let failure: string | null = null;

  return {
    id,
    get starts() {
      return starts;
    },
    start(): Promise<void> {
      starts += 1;
      if (failure !== null) {
        const message = failure;
        failure = null;
        return Promise.reject(new Error(message));
      }
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
    subscribe: () => () => undefined,
    health: (): SourceHealth => ({ state: 'live', lastObservationAt: 0 as MonoMs }),
    onExit(listener) {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    crash(reason) {
      for (const listener of [...exits]) listener(reason);
    },
    failNextStart(message) {
      failure = message;
    },
  };
}

describe('the supervisor (§8.1)', () => {
  it('restarts a source that exits, on the backoff schedule', async () => {
    const timers = manualTimers();
    const source = fakeSource('sidecar');
    const supervisor = createSourceSupervisor({ publish: () => undefined, timers });

    supervisor.add(source, SIDECAR_RESTART);
    await supervisor.start();
    expect(source.starts).toBe(1);

    source.crash('exited with code 1');
    // Scheduled, not immediate: a crash loop with no delay is a fork bomb.
    expect(source.starts).toBe(1);
    expect(timers.depth).toBe(1);

    timers.advance();
    await Promise.resolve();
    expect(source.starts).toBe(2);
  });

  it('gives up after the cap rather than retrying a binary that is not there', async () => {
    const timers = manualTimers();
    const source = fakeSource('sidecar');
    const supervisor = createSourceSupervisor({ publish: () => undefined, timers });

    supervisor.add(source, { restart: true, backoffMs: [1], maxAttempts: 2 });
    await supervisor.start();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      source.crash('ENOENT');
      while (timers.advance()) await Promise.resolve();
    }

    // One initial start plus exactly `maxAttempts` restarts.
    expect(source.starts).toBe(3);
    const status = supervisor.status(0 as MonoMs)[0]!;
    expect(status.health.state).toBe('down');
    expect(status.health.reason).toContain('gave up');
  });

  it('treats a failed start as an exit, because a missing binary fails there', async () => {
    const timers = manualTimers();
    const source = fakeSource('sidecar');
    source.failNextStart('spawn ENOENT');
    const supervisor = createSourceSupervisor({ publish: () => undefined, timers });

    supervisor.add(source, SIDECAR_RESTART);
    await supervisor.start();

    expect(timers.depth).toBe(1);
    timers.advance();
    await Promise.resolve();
    expect(source.starts).toBe(2);
  });

  it('never restarts a source whose policy forbids it — a quiet GSI is not a broken one', async () => {
    const timers = manualTimers();
    const source = fakeSource('gsi');
    const supervisor = createSourceSupervisor({ publish: () => undefined, timers });

    supervisor.add(source, NO_RESTART);
    await supervisor.start();
    source.crash('closed');

    expect(timers.depth).toBe(0);
    expect(source.starts).toBe(1);
  });

  it('does not restart after `stop()`', async () => {
    const timers = manualTimers();
    const source = fakeSource('sidecar');
    const supervisor = createSourceSupervisor({ publish: () => undefined, timers });

    supervisor.add(source, SIDECAR_RESTART);
    await supervisor.start();
    await supervisor.stop();
    source.crash('exited');

    expect(timers.depth).toBe(0);
    expect(source.starts).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------

const status = (id: string, state: SourceHealth['state']): SourceStatus => ({
  id,
  restarts: 0,
  health: { state, lastObservationAt: null },
});

describe('degradation (§8.2)', () => {
  it('sheds immediately when vision goes down', () => {
    const controller = createDegradationController({ visionSources: ['sidecar'] });
    const sources = [status('gsi', 'live'), status('sidecar', 'live')];

    expect(controller.evaluate({ sources, drift: 'ok' }, 0 as MonoMs)).toBe('full');
    expect(
      controller.evaluate(
        { sources: [status('gsi', 'live'), status('sidecar', 'down')], drift: 'ok' },
        1_000 as MonoMs,
      ),
    ).toBe('gsi_only');
  });

  it('waits out the hysteresis before coming back up', () => {
    const controller = createDegradationController({ visionSources: ['sidecar'] });
    const down = [status('gsi', 'live'), status('sidecar', 'down')];
    const up = [status('gsi', 'live'), status('sidecar', 'live')];

    controller.evaluate({ sources: down, drift: 'ok' }, 0 as MonoMs);
    expect(controller.evaluate({ sources: up, drift: 'ok' }, 1_000 as MonoMs)).toBe('gsi_only');
    expect(
      controller.evaluate({ sources: up, drift: 'ok' }, (1_000 + RECOVERY_HYSTERESIS_MS) as MonoMs),
    ).toBe('full');
  });

  it('resets the recovery window when the source fails again during it', () => {
    const controller = createDegradationController({ visionSources: ['sidecar'] });
    const down = [status('gsi', 'live'), status('sidecar', 'down')];
    const up = [status('gsi', 'live'), status('sidecar', 'live')];

    controller.evaluate({ sources: down, drift: 'ok' }, 0 as MonoMs);
    controller.evaluate({ sources: up, drift: 'ok' }, 1_000 as MonoMs);
    controller.evaluate({ sources: down, drift: 'ok' }, 5_000 as MonoMs);
    // The clock has passed the original window, but the window restarted.
    expect(
      controller.evaluate(
        { sources: up, drift: 'ok' },
        (5_000 + RECOVERY_HYSTERESIS_MS - 1) as MonoMs,
      ),
    ).toBe('gsi_only');
  });

  it('is `gsi_only` when vision is turned off entirely, not `full`', () => {
    const controller = createDegradationController({ visionSources: ['sidecar'] });
    expect(
      controller.evaluate({ sources: [status('gsi', 'live')], drift: 'unknown' }, 0 as MonoMs),
    ).toBe('gsi_only');
  });

  it('says something a user can act on when there is no game data', () => {
    const controller = createDegradationController({ visionSources: [] });
    const summary = controller.summarise({ sources: [status('gsi', 'down')], drift: 'unknown' });
    expect(summary).toContain('Dota 2');
  });
});

// -------------------------------------------------------------------------------------------

describe('the subsystem, wired', () => {
  it('applies observations to the world model and bumps its version', async () => {
    const timers = manualTimers();
    const source = fakeSource('gsi');
    // A holder rather than a `let`: TypeScript narrows a `let` assigned only inside a callback to
    // `never` at the read site, and the workaround is not worth an assertion.
    const sink: { publish: ((o: Observation) => void) | null } = { publish: null };

    const state = buildStateSubsystem({
      clock: { now: () => 0 as MonoMs },
      timers,
      sources: [
        {
          policy: NO_RESTART,
          source: {
            ...source,
            subscribe(listener) {
              sink.publish = listener;
              return () => undefined;
            },
          },
        },
      ],
    });

    await state.start();
    expect(sink.publish).not.toBeNull();

    const before = state.world.version;
    sink.publish?.({
      kind: 'gsi.payload',
      sourceId: 'gsi' as SourceId,
      seq: 0,
      receivedAt: 0 as MonoMs,
      payload: {
        map: { matchid: '1', clock_time: 10, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' },
      },
      v: 1,
    });
    expect(state.world.version).toBeGreaterThan(before);
  });

  it('resets the world model on a new match, before announcing it', async () => {
    const timers = manualTimers();
    interface Started {
      type: 'match_started';
      matchId: string;
      heroes: readonly string[];
    }
    const lifecycle: { fire: ((events: readonly Started[]) => void) | null } = { fire: null };

    const state = buildStateSubsystem({
      clock: { now: () => 0 as MonoMs },
      timers,
      sources: [
        {
          policy: NO_RESTART,
          source: fakeSource('gsi'),
          lifecycle: (listener) => {
            lifecycle.fire = listener;
            return () => undefined;
          },
        },
      ],
    });
    await state.start();

    const order: string[] = [];
    state.world.onVersion(() => order.push('reset'));
    state.onLifecycle(() => order.push('announced'));

    lifecycle.fire?.([{ type: 'match_started', matchId: '999', heroes: [] }]);

    // A listener rebuilding the preamble reads the world model, so the reset has to have happened
    // by the time it is told. Announcing first is the wrongness §6.4 exists to prevent.
    expect(order).toEqual(['reset', 'announced']);
    expect(state.matchId).toBe('999');
  });
});

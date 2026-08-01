/**
 * `SourceSupervisor` — `state-capture-architecture.md` §8.1.
 *
 * Restart with exponential backoff and a cap. The one thing worth being careful about is *which*
 * failures it reacts to, because the three sources fail in two different ways:
 *
 * - The **sidecar** exits. That is an event, it is expected (dota2 §3 requires the sidecar to be
 *   able to crash without taking the agent down), and it is what `restart` is for.
 * - **GSI and the log tailer** do not exit. They go quiet — Dota is closed, or the player is in
 *   the main menu — and a quiet source is not a broken one. Restarting a healthy HTTP listener
 *   because nobody has POSTed for a minute would close the socket Dota is about to use.
 *
 * So `health()` going `down` is *reported*, never acted on. Only a source that reports a start
 * failure or announces its own exit is restarted, and only if its policy says so.
 *
 * The backoff array is walked and then held at its last entry, rather than doubling forever: a
 * sidecar binary that is missing will fail identically every time, and the useful behaviour there
 * is a steady slow retry plus a cap that eventually stops, not an interval that grows to an hour.
 */

import type { Timers } from '@riki/context';
import type {
  MonoMs,
  Observation,
  RestartPolicy,
  SourceStatus,
  SourceSupervisor,
  SupervisedSource,
} from './contracts.js';

export interface SupervisorTelemetry {
  sourceStarted(id: string): void;
  /** `attempt` is 1-based and counts restarts, so the first start is not reported here. */
  sourceRestarted(id: string, attempt: number, delayMs: number): void;
  /** The source is not coming back: either its policy forbids restart, or the cap was reached. */
  sourceGaveUp(id: string, reason: string): void;
}

export interface SourceSupervisorDeps {
  /** Every observation from every source, already tagged by the source itself. */
  readonly publish: (o: Observation) => void;
  readonly timers: Timers;
  readonly telemetry?: SupervisorTelemetry;
}

interface Entry {
  readonly source: SupervisedSource;
  readonly policy: RestartPolicy;
  unsubscribe: (() => void) | null;
  cancelPending: (() => void) | null;
  restarts: number;
  gaveUp: string | null;
}

/**
 * A source that can tell the supervisor it died.
 *
 * Structural rather than a required part of `SupervisedSource`: the GSI listener and the log
 * tailer have no such event, and forcing them to declare one they never fire would be a method
 * whose only implementation is `() => () => undefined`.
 */
export interface ExitingSource extends SupervisedSource {
  onExit(listener: (reason: string) => void): () => void;
}

function canExit(source: SupervisedSource): source is ExitingSource {
  return 'onExit' in source && typeof (source as ExitingSource).onExit === 'function';
}

export function createSourceSupervisor(deps: SourceSupervisorDeps): SourceSupervisor {
  const entries: Entry[] = [];
  let running = false;

  function delayFor(policy: RestartPolicy, attempt: number): number {
    if (policy.backoffMs.length === 0) return 0;
    const index = Math.min(attempt, policy.backoffMs.length - 1);
    return policy.backoffMs[index] ?? 0;
  }

  function detach(entry: Entry): void {
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.cancelPending?.();
    entry.cancelPending = null;
  }

  function scheduleRestart(entry: Entry, reason: string): void {
    if (!running || entry.gaveUp !== null) return;

    if (!entry.policy.restart) {
      entry.gaveUp = reason;
      deps.telemetry?.sourceGaveUp(entry.source.id, reason);
      return;
    }
    if (entry.restarts >= entry.policy.maxAttempts) {
      entry.gaveUp = `gave up after ${String(entry.restarts)} restarts: ${reason}`;
      deps.telemetry?.sourceGaveUp(entry.source.id, entry.gaveUp);
      return;
    }

    const delayMs = delayFor(entry.policy, entry.restarts);
    entry.restarts += 1;
    deps.telemetry?.sourceRestarted(entry.source.id, entry.restarts, delayMs);

    entry.cancelPending = deps.timers.after(delayMs, () => {
      entry.cancelPending = null;
      void launch(entry);
    });
  }

  async function launch(entry: Entry): Promise<void> {
    if (!running || entry.gaveUp !== null) return;
    detach(entry);

    entry.unsubscribe = entry.source.subscribe(deps.publish);
    if (canExit(entry.source)) {
      const stopWatching = entry.source.onExit((reason) => {
        scheduleRestart(entry, reason);
      });
      const stopSubscription = entry.unsubscribe;
      entry.unsubscribe = (): void => {
        stopWatching();
        stopSubscription();
      };
    }

    try {
      await entry.source.start();
      deps.telemetry?.sourceStarted(entry.source.id);
    } catch (error: unknown) {
      // A start that throws is the same event as an exit, and it is the common one for the
      // sidecar: a missing binary fails here rather than by exiting.
      detach(entry);
      scheduleRestart(entry, error instanceof Error ? error.message : 'start failed');
    }
  }

  return {
    add(source: SupervisedSource, policy: RestartPolicy): void {
      entries.push({
        source,
        policy,
        unsubscribe: null,
        cancelPending: null,
        restarts: 0,
        gaveUp: null,
      });
    },

    async start(): Promise<void> {
      if (running) return;
      running = true;
      // Concurrently: the GSI listener binding a socket must not be behind the sidecar's process
      // spawn, and neither of them depends on the other having started.
      await Promise.all(entries.map((entry) => launch(entry)));
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      for (const entry of entries) detach(entry);
      await Promise.all(
        entries.map(async (entry) => {
          try {
            await entry.source.stop();
          } catch {
            // Shutdown is best-effort by definition: a source that cannot stop cleanly must not
            // stop the app from quitting, and there is nothing left to report it to.
          }
        }),
      );
    },

    status(now: MonoMs): readonly SourceStatus[] {
      return entries.map((entry) => ({
        id: entry.source.id,
        restarts: entry.restarts,
        health:
          entry.gaveUp === null
            ? entry.source.health(now)
            : { state: 'down', lastObservationAt: null, reason: entry.gaveUp },
      }));
    },
  };
}

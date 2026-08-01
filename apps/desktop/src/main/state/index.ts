/**
 * `buildStateSubsystem` — the wiring half of `state-capture-architecture.md` §8.
 *
 * Sources arrive by injection rather than being constructed here, which is the difference between
 * a subsystem that can be driven by `FakeGsiSource` over `fixtures/gsi/*.jsonl` and one that needs
 * Dota running. The shell decides which sources exist; this decides what happens to what they
 * produce.
 *
 * Two behaviours live here and nowhere else, both from §6.4:
 *
 * - **Match lifecycle drives the store.** A new `match_id` resets it, a pause freezes game-time
 *   ageing, and a clock discontinuity is a resync rather than a slow drift into wrongness. The
 *   sources report edges; reacting to them is composition's job.
 * - **Every one of those paths counts.** dota2 §9's rule is *degrade loudly to the developer,
 *   quietly to the user, and never silently into wrongness*, and the shape that takes here is that
 *   no path discards an observation without incrementing something.
 */

import type { Timers } from '@riki/context';
import type { MatchLifecycleEvent } from '@riki/gsi';
import type { Clock, MonoMs, WorldModelStore, WorldModelStoreOptions } from '@riki/world-model';
import { createWorldModelStore } from '@riki/world-model';

import type {
  ObservationBus,
  RestartPolicy,
  StateSubsystem,
  SubsystemHealth,
  SupervisedSource,
} from './contracts.js';
import { createObservationBus } from './bus.js';
import { createSourceSupervisor, type SupervisorTelemetry } from './supervisor.js';
import {
  createDegradationController,
  healthOf,
  type CvDriftStatus,
  type DegradationController,
} from './degradation.js';

export * from './contracts.js';
export { gsiRegistration, logTailRegistration } from './gsi-source.js';
export { createObservationBus } from './bus.js';
export { createSourceSupervisor } from './supervisor.js';
export type { ExitingSource, SourceSupervisorDeps, SupervisorTelemetry } from './supervisor.js';
export { createDegradationController, healthOf, RECOVERY_HYSTERESIS_MS } from './degradation.js';
export type {
  CvDriftStatus,
  DegradationController,
  DegradationInput,
  DegradationOptions,
} from './degradation.js';

/** A source plus how hard to try when it dies. */
export interface SourceRegistration {
  readonly source: SupervisedSource;
  readonly policy: RestartPolicy;
  /**
   * Lifecycle edges, if this source produces them. Only `packages/gsi` does: it is the only source
   * that sees `match_id`, and §6.4's whole table is keyed on things only it observes.
   */
  readonly lifecycle?: (listener: (events: readonly MatchLifecycleEvent[]) => void) => () => void;
}

export interface StateTelemetry extends SupervisorTelemetry {
  /** A reset, with the reason from §6.4's table. Never silent — that is the whole rule. */
  worldReset(reason: string): void;
  matchStarted(matchId: string): void;
  matchEnded(matchId: string): void;
  degraded(from: string, to: string, summary: string): void;
}

export interface StateSubsystemDeps {
  readonly clock: Clock;
  readonly timers: Timers;
  readonly sources: readonly SourceRegistration[];
  readonly telemetry?: StateTelemetry;
  readonly store?: WorldModelStoreOptions;
  /** Source ids that carry CV, for the degradation controller. */
  readonly visionSources?: readonly string[];
}

export interface StateSubsystemWithExtras extends StateSubsystem {
  /** `match_started` / `match_ended`, forwarded so the shell can rebuild the Tier 1 preamble. */
  onLifecycle(listener: (event: MatchLifecycleEvent) => void): () => void;
  /** The current match, or null between games. The shell needs it for `ContextAssembler`. */
  readonly matchId: string | null;
  readonly degradation: DegradationController;
}

export function buildStateSubsystem(deps: StateSubsystemDeps): StateSubsystemWithExtras {
  const { clock, telemetry } = deps;

  const world: WorldModelStore = createWorldModelStore(deps.store ?? {});
  const bus: ObservationBus = createObservationBus();
  const degradation = createDegradationController(
    deps.visionSources === undefined ? {} : { visionSources: deps.visionSources },
  );

  const supervisor = createSourceSupervisor({
    publish: (o) => {
      bus.publish(o);
    },
    timers: deps.timers,
    ...(telemetry === undefined ? {} : { telemetry }),
  });

  const lifecycleListeners = new Set<(event: MatchLifecycleEvent) => void>();
  const unsubscribes: (() => void)[] = [];

  let matchId: string | null = null;
  // Reported to the degradation controller. Stays `unknown` until the sidecar speaks a protocol
  // (REPO_SKELETON.md §10 step 2) — see `state/README` note in `degradation.ts`.
  const drift: CvDriftStatus = 'unknown';
  let lastLevel = degradation.level;

  /** §6.1 step 5: the bus delivers, and this is the only thing that writes to the store. */
  unsubscribes.push(
    bus.subscribe((o) => {
      world.apply(o, clock.now());
    }),
  );

  function onLifecycleEvents(events: readonly MatchLifecycleEvent[]): void {
    const now = clock.now();
    for (const event of events) {
      switch (event.type) {
        case 'match_started':
          // Reset *before* announcing: a listener rebuilding the preamble reads the world model,
          // and reading the previous match's facts is exactly the wrongness §6.4 is about.
          matchId = event.matchId;
          world.reset('new_match', now);
          telemetry?.worldReset('new_match');
          telemetry?.matchStarted(event.matchId);
          break;

        case 'match_ended':
          matchId = null;
          telemetry?.matchEnded(event.matchId);
          break;

        case 'paused':
          world.setPaused(true, now);
          break;

        case 'resumed':
          world.setPaused(false, now);
          break;

        case 'clock_discontinuity':
          // A resync, not a drift. The store's reset is the blunt version of §6.4's "mark all CV
          // facts stale, keep GSI" — which needs per-source invalidation the store does not expose
          // yet, so this over-corrects deliberately rather than under-correcting silently.
          world.reset('clock_discontinuity', now);
          telemetry?.worldReset('clock_discontinuity');
          break;

        case 'phase_changed':
          break;
      }
      for (const listener of [...lifecycleListeners]) listener(event);
    }
  }

  for (const registration of deps.sources) {
    supervisor.add(registration.source, registration.policy);
    if (registration.lifecycle !== undefined) {
      unsubscribes.push(registration.lifecycle(onLifecycleEvents));
    }
  }

  return {
    world,
    bus,
    degradation,

    get matchId(): string | null {
      return matchId;
    },

    onLifecycle(listener): () => void {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },

    health(now: MonoMs): SubsystemHealth {
      const health = healthOf(supervisor.status(now), degradation, drift, now);
      if (health.level !== lastLevel) {
        telemetry?.degraded(lastLevel, health.level, health.summary);
        lastLevel = health.level;
      }
      return health;
    },

    start(): Promise<void> {
      return supervisor.start();
    },

    async stop(): Promise<void> {
      for (const stop of unsubscribes) stop();
      unsubscribes.length = 0;
      lifecycleListeners.clear();
      await supervisor.stop();
      world.reset('shutdown', clock.now());
    },
  };
}

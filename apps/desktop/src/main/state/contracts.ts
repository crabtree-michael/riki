/**
 * The state subsystem's own vocabulary: sources, supervision, health and degradation.
 *
 * `state-capture-architecture.md` §8 puts the wiring here and says why: nothing in `packages/gsi`,
 * `packages/log-tail` or `packages/world-model` constructs anything, so this is the one directory
 * where all three names appear together. It holds no domain logic — every decision it makes is
 * about *processes and liveness*, never about facts.
 *
 * **`ObservationSource` is mirrored, not imported.** `packages/world-model`'s `observation.ts`
 * declares the same shape and says why: a source may not import the model and the model may not
 * import a source (ADR-0014), so the three copies are structurally identical and meet here. They
 * collapse into `@riki/protocol` at REPO_SKELETON.md §10 step 2, which has not landed.
 */

import type {
  MonoMs,
  Observation,
  ObservationKind,
  SourceHealth,
  WorldModelStore,
} from '@riki/world-model';

export type { MonoMs, Observation, ObservationKind, SourceHealth };

/**
 * What every live source satisfies.
 *
 * Deliberately narrower than `packages/world-model`'s `ObservationSource<K>`: the supervisor never
 * needs the kind at the type level, and widening `Observation<K>` to `Observation` here is what
 * lets one heterogeneous list hold the GSI listener, the log tailer and the sidecar.
 */
export interface SupervisedSource {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (o: Observation) => void): () => void;
  health(now: MonoMs): SourceHealth;
}

/**
 * How hard to try when a source dies.
 *
 * The sidecar is the one that will actually crash — dota2 §3 requires it to crash without taking
 * the agent down — so `maxAttempts` is not a failure budget so much as a stop condition for the
 * case where the binary is missing entirely and every restart will fail identically.
 */
export interface RestartPolicy {
  /** `false` for GSI and the log tailer: they fail by going quiet, not by throwing. */
  readonly restart: boolean;
  readonly backoffMs: readonly number[];
  readonly maxAttempts: number;
}

/** GSI and the log tailer restart on configuration change, not on error (§8.1). */
export const NO_RESTART: RestartPolicy = { restart: false, backoffMs: [], maxAttempts: 0 };

/** The sidecar. Capped so a missing binary does not become a spin loop (§8.1). */
export const SIDECAR_RESTART: RestartPolicy = {
  restart: true,
  backoffMs: [500, 1_000, 2_000, 5_000, 10_000],
  maxAttempts: 10,
};

export interface SourceStatus {
  readonly id: string;
  readonly health: SourceHealth;
  /** How many times the supervisor has restarted this source since `start()`. */
  readonly restarts: number;
}

export interface SubsystemHealth {
  readonly sources: readonly SourceStatus[];
  readonly level: DegradationLevel;
  /** One line, safe to show a user. Never a token, a path or chat text. */
  readonly summary: string;
}

/**
 * The shed order from dota2 §5, in one place.
 *
 * Minimap is last because it is the highest-value CV signal, which is why `gsi_only` is the floor
 * rather than a level with the minimap still in it.
 */
export type DegradationLevel = 'full' | 'no_vlm' | 'no_scoreboard' | 'no_topbar' | 'gsi_only';

export const DEGRADATION_LEVELS: readonly DegradationLevel[] = [
  'full',
  'no_vlm',
  'no_scoreboard',
  'no_topbar',
  'gsi_only',
];

export interface SourceSupervisor {
  add(source: SupervisedSource, policy: RestartPolicy): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Cheap and synchronous. Polled on a timer; must not do I/O. */
  status(now: MonoMs): readonly SourceStatus[];
}

/**
 * The bus, per §6.3.
 *
 * Bounded per kind with policy by kind, because the two kinds fail differently: losing a GSI POST
 * loses information nothing else carries, while a stale minimap frame is worthless the moment a
 * newer one exists.
 */
export interface ObservationBus {
  publish(o: Observation): void;
  subscribe(fn: (o: Observation) => void): () => void;
  stats(): BusStats;
}

export interface BusStats {
  readonly depth: number;
  readonly dropped: ReadonlyMap<ObservationKind, number>;
  /** A `seq` that went backwards or skipped, per source. A rising rate on the sidecar is a signal. */
  readonly gaps: ReadonlyMap<string, number>;
}

/** What the shell sees. Nothing above this line knows an Electron app exists. */
export interface StateSubsystem {
  readonly world: WorldModelStore;
  readonly bus: ObservationBus;
  health(now: MonoMs): SubsystemHealth;
  start(): Promise<void>;
  stop(): Promise<void>;
}

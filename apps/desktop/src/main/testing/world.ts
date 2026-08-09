/**
 * A world to render against, without a game.
 *
 * `packages/world-model` ships builders for an `Observation` — the *input* to fusion — which is the
 * right tool for a fusion test and the wrong one here: main reads the *output*, and going through
 * the reducer to arrange one fact would make every snapshot test a test of precedence as well. So
 * this builds a `WorldState` directly and snapshots it, using that package's own `writeFact`,
 * `createSnapshot`, staleness policy and derived registry — nothing here reimplements a world, which
 * is what keeps these tests honest when fusion changes.
 *
 * It lived in `@riki/events/testing` until ADR-0042 deleted that package. It moved here rather than
 * into `packages/world-model/testing` because main is now its only consumer, and a fixture builder
 * with one consumer belongs beside it.
 */

import type {
  Fact,
  FieldPath,
  GameClock,
  MonoMs,
  Timestamps,
  WorldDelta,
  WorldModelReader,
  WorldSnapshot,
  WorldState,
} from '@riki/world-model';
import {
  asConfidence,
  asDetectorId,
  asGameClock,
  asMonoMs,
  createDeltaComputer,
  createDerivedRegistry,
  createSnapshot,
  createStalenessPolicy,
  cvFact,
  defaultDerivedRules,
  emptyState,
  gsiFact,
  writeFact,
} from '@riki/world-model';
import type { DetectorId, GoldUntilItemOptions } from '@riki/world-model';

export interface PutOptions {
  /** How old the fact is, in **game** seconds — the basis every tactical field ages on. */
  readonly ageSeconds?: number;
  /** Anything below 1 makes it a CV fact, because only CV can carry one (`cvFact`). */
  readonly confidence?: number;
}

export interface WorldOptions {
  readonly now?: number;
  /** `null` is pre-horn, and it is a case worth reaching: the header renders differently for it. */
  readonly clock?: number | null;
  /** What the player is saving for. Without it, `goldUntilItem` stays dark. */
  readonly goldTarget?: GoldUntilItemOptions['target'];
}

export interface WorldBuilder {
  put(path: FieldPath, value: unknown, opts?: PutOptions): WorldBuilder;
  /** Advances the clock without touching a fact, so everything already in the world ages. */
  advance(seconds: number): WorldBuilder;
  snapshot(): WorldSnapshot;
  /** The delta since the last `commit()`. */
  commit(): WorldDelta;
  /** A reader over this world. `onVersion` fires on every `commit()`. */
  reader(): WorldModelReader;
  readonly clock: GameClock | null;
  readonly now: MonoMs;
}

const MS_PER_SECOND = 1000;
const TEST_DETECTOR: DetectorId = asDetectorId('test');

export function buildWorld(options: WorldOptions = {}): WorldBuilder {
  const staleness = createStalenessPolicy();
  const derived = createDerivedRegistry(
    defaultDerivedRules({
      staleness,
      ...(options.goldTarget === undefined
        ? {}
        : { goldUntilItem: { target: options.goldTarget } }),
    }),
  );
  const deltas = createDeltaComputer();

  let now = asMonoMs(options.now ?? 0);
  let clock: GameClock | null = options.clock === null ? null : asGameClock(options.clock ?? 600);
  let state: WorldState = emptyState(now);
  let committed: WorldState = state;
  const listeners = new Set<(version: number, delta: WorldDelta) => void>();

  function stampsFor(ageSeconds: number): Timestamps {
    return {
      observedAt: asMonoMs(now - ageSeconds * MS_PER_SECOND),
      atGameClock: clock === null ? null : asGameClock(clock - ageSeconds),
    };
  }

  const builder: WorldBuilder = {
    put(path: FieldPath, value: unknown, opts: PutOptions = {}): WorldBuilder {
      const at = stampsFor(opts.ageSeconds ?? 0);
      const confidence = opts.confidence;
      const fact: Fact<unknown> =
        confidence === undefined || confidence >= 1
          ? gsiFact(value, at)
          : cvFact(value, at, asConfidence(confidence), TEST_DETECTOR);
      state = writeFact(state, path, fact);
      return builder;
    },

    advance(seconds: number): WorldBuilder {
      now = asMonoMs(now + seconds * MS_PER_SECOND);
      if (clock !== null) clock = asGameClock(clock + seconds);
      return builder;
    },

    snapshot(): WorldSnapshot {
      return createSnapshot({ state, now, clock, staleness, derived });
    },

    commit(): WorldDelta {
      const next: WorldState = { ...state, version: committed.version + 1 };
      const delta = deltas.compute(committed, next);
      state = next;
      committed = next;
      for (const listener of listeners) listener(next.version, delta);
      return delta;
    },

    reader(): WorldModelReader {
      return {
        snapshot: () => createSnapshot({ state, now, clock, staleness, derived }),
        onVersion(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        history: () => [],
      };
    },

    get clock(): GameClock | null {
      return clock;
    },
    get now(): MonoMs {
      return now;
    },
  };

  return builder;
}

/** A clock driven by hand. Nothing in a test should wait for a real millisecond. */
export interface ManualWorldClock {
  now(): MonoMs;
  set(ms: number): void;
  advance(ms: number): void;
}

export function manualClock(start = 0): ManualWorldClock {
  let value = asMonoMs(start);
  return {
    now: () => value,
    set: (ms: number) => {
      value = asMonoMs(ms);
    },
    advance: (ms: number) => {
      value = asMonoMs(value + ms);
    },
  };
}

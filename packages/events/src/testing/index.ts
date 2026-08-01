/**
 * A world to detect against, without a game.
 *
 * `packages/world-model` ships builders for an `Observation` — the *input* to fusion — which is the
 * right tool for a fusion test and the wrong one here: this package reads the *output*, and going
 * through the reducer to arrange one fact would make every detector test a test of precedence as
 * well. So this builds a `WorldState` directly and snapshots it, using that package's own
 * `writeFact`, `createSnapshot`, staleness policy and derived registry — nothing here reimplements
 * a world, which is what keeps these tests honest when fusion changes.
 *
 * Exported as `@riki/events/testing` so the composition root's tests can use the same builder,
 * because a fixture that drifts between two packages is a test that passes for the wrong reason.
 */

import type { AdviceRecord, AdviceTopic, CoachingMemoryReader } from '@riki/context';
import { topicKey } from '@riki/context';
import type {
  DetectorId,
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
import type { GoldUntilItemOptions } from '@riki/world-model';

export interface PutOptions {
  /** How old the fact is, in **game** seconds — the basis every tactical field ages on. */
  readonly ageSeconds?: number;
  /** Anything below 1 makes it a CV fact, because only CV can carry one (`cvFact`). */
  readonly confidence?: number;
}

export interface WorldOptions {
  readonly now?: number;
  /** `null` is pre-horn, and it is a case worth reaching: several rules refuse without a clock. */
  readonly clock?: number | null;
  /** What the player is saving for. Without it, `goldUntilItem` — and one detector — stay dark. */
  readonly goldTarget?: GoldUntilItemOptions['target'];
}

export interface WorldBuilder {
  put(path: FieldPath, value: unknown, opts?: PutOptions): WorldBuilder;
  /** Advances the clock without touching a fact, so everything already in the world ages. */
  advance(seconds: number): WorldBuilder;
  snapshot(): WorldSnapshot;
  /** The delta since the last `commit()`, for the intensity fold — the one thing that needs one. */
  commit(): WorldDelta;
  /** A reader over this world, for the engine. `onVersion` fires on every `commit()`. */
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

/** A `Clock` for the engine, driven by hand. Nothing in a test should wait for a real millisecond. */
export interface ManualClock {
  now(): MonoMs;
  set(ms: number): void;
  advance(ms: number): void;
}

export function manualClock(start = 0): ManualClock {
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

/**
 * A `CoachingMemoryReader` that is a `Map`, which is what makes every novelty-gate test Tier 1.
 *
 * `packages/context`'s real one is a projection over the ledger, and wiring that in would make a
 * gate test depend on `agent_said` entry shapes it has no opinion about. The one behaviour worth
 * copying is `recent`'s: it is scoped by **game** seconds measured back from the latest known
 * clock, not by a `now` the caller passes.
 */
export function fakeCoachingMemory(
  records: readonly AdviceRecord[] = [],
  latestClock: GameClock | null = null,
): CoachingMemoryReader {
  const byKey = new Map(records.map((record) => [topicKey(record.topic), record]));

  return {
    recent(topic: AdviceTopic, within: number): AdviceRecord | undefined {
      const record = byKey.get(topicKey(topic));
      if (record === undefined) return undefined;
      if (latestClock === null) return record;
      return latestClock - record.lastAt <= within ? record : undefined;
    },
    lastSpokeAt: () => latestClock,
    silentFor: (at: GameClock) => (latestClock === null ? 0 : Math.max(0, at - latestClock)),
  };
}

/** One `AdviceRecord`, with the three fields a gate test actually varies. */
export function adviceRecord(
  topic: AdviceTopic,
  overrides: Partial<Omit<AdviceRecord, 'topic'>> = {},
): AdviceRecord {
  const at = overrides.lastAt ?? asGameClock(0);
  return {
    topic,
    firstAt: overrides.firstAt ?? at,
    lastAt: at,
    count: overrides.count ?? 1,
    response: overrides.response ?? 'unknown',
  };
}

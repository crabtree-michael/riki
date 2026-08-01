/**
 * The single writer, and the only mutable thing in this package.
 *
 * A thin shell around pure functions: `apply` folds an observation through the reducer, bumps the
 * version if anything actually changed, and notifies. Everything it delegates to is testable
 * without it.
 *
 * See docs/design/state-capture-architecture.md §5.1.
 */

import type { DerivedRegistry } from './derived/registry.js';
import { createDerivedRegistry } from './derived/registry.js';
import { defaultDerivedRules } from './derived/rules/index.js';
import type { ConfidenceGate } from './fusion/confidence.js';
import { createConfidenceGate } from './fusion/confidence.js';
import type { PrecedencePolicy } from './fusion/precedence.js';
import { createPrecedencePolicy } from './fusion/precedence.js';
import type { FusionPolicies, RejectionReason } from './fusion/reducer.js';
import { fuse } from './fusion/reducer.js';
import type { StalenessPolicy } from './fusion/staleness.js';
import { createStalenessPolicy } from './fusion/staleness.js';
import type { WorldDelta } from './history/delta.js';
import { createDeltaComputer } from './history/delta.js';
import type { Observation } from './observation.js';
import type { WorldSnapshot } from './snapshot.js';
import { createSnapshot } from './snapshot.js';
import type { WorldState } from './state.js';
import { DEFAULT_HISTORY_WINDOW_SECONDS, emptyState } from './state.js';
import type { GameClock, MonoMs, Unsubscribe } from './time.js';

export interface ApplyResult {
  readonly changed: boolean;
  readonly version: number;
  readonly accepted: number;
  /** Never silent: a drop that nobody counts is a bug that nobody finds. */
  readonly rejected: readonly RejectionReason[];
}

export type ResetReason = 'new_match' | 'reconnect' | 'clock_discontinuity' | 'shutdown';

export interface WorldModelStoreOptions {
  readonly precedence?: PrecedencePolicy;
  readonly confidence?: ConfidenceGate;
  readonly staleness?: StalenessPolicy;
  readonly derived?: DerivedRegistry;
  /** dota2 §4 asks for ~5 minutes of delta history. */
  readonly historyWindowSeconds?: number;
}

/**
 * The read half, and the entirety of what `packages/context` and `packages/events` are given.
 *
 * Nothing here mentions tokens, prompts, turns or messages. The behavioural test that this holds:
 * the world model should be usable by a replay tool that renders a match timeline to a terminal
 * with no LLM anywhere. If that becomes awkward to write, something has leaked (§7.3).
 */
export interface WorldModelReader {
  snapshot(now: MonoMs): WorldSnapshot;
  onVersion(listener: (version: number, delta: WorldDelta) => void): Unsubscribe;
  history(since: GameClock): readonly WorldDelta[];
}

export interface WorldModelStore extends WorldModelReader {
  /** The single writer. Synchronous, allocation-light, target < 1 ms (§6.1's 10 ms end-to-end). */
  apply(o: Observation, now: MonoMs): ApplyResult;

  readonly version: number;

  /** Keeps nothing but the session identity. */
  reset(reason: ResetReason, now: MonoMs): void;

  /** Stops game-time ageing without discarding anything — see fusion/staleness.ts. */
  setPaused(paused: boolean, now: MonoMs): void;

  /** What `setPaused` was last told, for the health surface. Not in §5.1; a write-only flag would
   * be untestable and the supervisor needs to render it. */
  readonly paused: boolean;
}

/**
 * `apply` is the only mutation in the package, and everything it does is a call into a pure
 * function plus one assignment. That is the shape ADR-0014 asks for, and the reason a fusion test
 * needs no store at all.
 *
 * The store reads no clock: `now` arrives on every call. It is the composition root that owns a
 * `Clock`, which is what keeps assumption ⚑2 mechanical rather than remembered.
 */
export function createWorldModelStore(opts: WorldModelStoreOptions = {}): WorldModelStore {
  const policies: FusionPolicies = {
    precedence: opts.precedence ?? createPrecedencePolicy(),
    confidence: opts.confidence ?? createConfidenceGate(),
    staleness: opts.staleness ?? createStalenessPolicy(),
  };
  const derived =
    opts.derived ?? createDerivedRegistry(defaultDerivedRules({ staleness: policies.staleness }));
  const deltas = createDeltaComputer();
  const historyWindowSeconds = opts.historyWindowSeconds ?? DEFAULT_HISTORY_WINDOW_SECONDS;

  let state = emptyState(0 as MonoMs, { historyWindowSeconds });
  let paused = false;
  const listeners = new Set<(version: number, delta: WorldDelta) => void>();

  /**
   * Version, delta and history all move together or not at all.
   *
   * Doing this in one place is what stops the three from disagreeing — a delta computed against a
   * state that was already replaced is the kind of bug that only shows up as an event firing
   * about a field that has since changed again.
   */
  const commit = (next: WorldState, now: MonoMs): WorldDelta => {
    const versioned: WorldState = { ...next, version: state.version + 1 };
    const delta = deltas.compute(state, versioned);
    state = versioned;
    state.history.push(delta, delta.atGameClock, now);
    for (const listener of listeners) listener(state.version, delta);
    return delta;
  };

  return {
    apply(o: Observation, now: MonoMs): ApplyResult {
      const outcome = fuse(state, o, now, policies);

      if (outcome.state === state) {
        return {
          changed: false,
          version: state.version,
          accepted: outcome.accepted,
          rejected: outcome.rejections,
        };
      }

      commit(outcome.state, now);
      return {
        changed: true,
        version: state.version,
        accepted: outcome.accepted,
        rejected: outcome.rejections,
      };
    },

    snapshot(now: MonoMs): WorldSnapshot {
      return createSnapshot({
        state,
        now,
        clock: state.meta.clock?.value ?? null,
        staleness: policies.staleness,
        derived,
      });
    },

    get version(): number {
      return state.version;
    },

    onVersion(listener: (version: number, delta: WorldDelta) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    history(since: GameClock): readonly WorldDelta[] {
      return state.history.since(since);
    },

    /**
     * Everything goes, including the rings.
     *
     * dota2 §9's cross-cutting rule is *never silently into wrongness*, and a reset is the one
     * place where discarding beats ageing: after a new match the old facts are not stale, they are
     * about a different game. The version keeps counting up so that a reader holding an old
     * snapshot can still tell that it is old.
     */
    reset(reason: ResetReason, now: MonoMs): void {
      // `commit` diffs against the current `state`, so the fresh one must not be installed first:
      // doing that would produce an empty delta and readers would never learn the model emptied.
      commit(emptyState(now, { historyWindowSeconds }), now);
      // The reason is not consumed here; it is what the composition root reports to the user and
      // what telemetry counts. Keeping it in the signature means a caller cannot reset without
      // having decided why.
      void reason;
    },

    /**
     * Pause does not touch a single fact.
     *
     * It does not need to: `map.clock_time` stops advancing while paused, and every tactical
     * ageing policy is on the `game` basis, so tactical facts stop ageing as a consequence of the
     * clock rather than of a flag (fusion/staleness.ts). Pipeline facts on the `wall` basis keep
     * ageing, which is exactly right — a client that has not POSTed for forty seconds of paused
     * game is still gone.
     *
     * So this records the state for the health surface and nothing else. If it ever grows a body,
     * that is a sign the two-clock rule has been worked around somewhere.
     */
    setPaused(next: boolean, now: MonoMs): void {
      paused = next;
      void now;
    },

    get paused(): boolean {
      return paused;
    },
  };
}

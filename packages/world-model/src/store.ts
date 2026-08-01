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
import type { ConfidenceGate } from './fusion/confidence.js';
import type { PrecedencePolicy } from './fusion/precedence.js';
import type { RejectionReason } from './fusion/reducer.js';
import type { StalenessPolicy } from './fusion/staleness.js';
import type { WorldDelta } from './history/delta.js';
import type { Observation } from './observation.js';
import type { WorldSnapshot } from './snapshot.js';
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
}

export declare function createWorldModelStore(opts?: WorldModelStoreOptions): WorldModelStore;

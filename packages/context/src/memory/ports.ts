/**
 * The three ports the memory layer reaches through, and nothing else.
 *
 * See docs/design/context-and-memory-architecture.md §8. Declarations only.
 */

import type { GameClock, Unsubscribe } from '../common/types.js';
import type { TapeEvent } from '../snapshot/types.js';
import type { AppliedWindowPlan, DropReason, LedgerRef, WindowPlan, WindowUsage } from './types.js';

/**
 * The `recent:` line. dota2 §3's architecture diagram has the event engine feeding the context
 * builder, and `packages/events` is the package that decides what an event *is* and how it reads —
 * so the tape arrives through a port this package declares and that one implements, wired in the
 * composition root.
 *
 * That inversion is what keeps `packages/context` free of any import of `@riki/events` while the
 * data flows the way the diagram says. The reverse edge, events reading `CoachingMemoryReader`, is
 * a plain import, so the graph stays a DAG: world-model → context → events.
 */
export interface EventTapeReader {
  /** The last n typed events, newest last, already salience-ordered by `packages/events`. */
  recent(n: number, since: GameClock | null): readonly TapeEvent[];
}

/**
 * Local key/value, four methods, no paths and no `fs`.
 *
 * The composition root implements it against a directory `packages/config` resolved — this package
 * never picks a path and never reads `process.env`. `FakeMemoryStore` is a `Map`, which is what
 * makes every durable-memory test Tier 1, and the lint rule in §2.3 is what keeps a convenient
 * `await fs.writeFile` from appearing inside `PlayerMemoryStore` later.
 */
export interface MemoryStore {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
}

/**
 * The seam with `packages/realtime` (§8.4).
 *
 * This package decides *what should not be in the window and what should replace it*; that package
 * decides *how to make it true* — `conversation.item.truncate`, the retention ratio, item ids, and
 * the order of operations. Neither half is testable in the other's terms, which is why the plan
 * crosses as a value rather than as a series of calls.
 */
export interface ContextWindowPort {
  apply(plan: WindowPlan): Promise<AppliedWindowPlan>;
  /** Includes truncations the API performed on its own — see `DropReason.api_truncation`. */
  onDropped(listener: (refs: readonly LedgerRef[], reason: DropReason) => void): Unsubscribe;
  /** Real usage when the session reports it (realtime §6). Null is unknown, never guessed. */
  usage(): WindowUsage | null;
}

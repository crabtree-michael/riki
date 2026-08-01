/**
 * The mechanism half of `ContextWindowPort` — policy is `packages/context`'s (its §8.4).
 *
 * That package decides what should leave the window and what replaces it, and hands over a
 * `WindowPlan`. This one decides how to make that true: item ids, the order of operations, the
 * retention ratio, and what to report back.
 *
 * Two rules that are not obvious from the port's shape:
 *
 * - **Create the summary item before deleting what it replaces.** The opposite order leaves a
 *   window that has forgotten a stretch of the match and does not yet have the replacement.
 * - **`usage()` returns `null` when nothing has been reported.** Never an estimate.
 *   `packages/context` runs a deliberately conservative estimator and measures its drift against
 *   this number (its §7.6); handing it a guess dressed as a measurement would destroy the only
 *   ground truth in that loop.
 *
 * An `api_truncation` report is a bug, not a condition: it means our accounting let the API reach
 * the ceiling first, and the API truncates oldest-first — which takes the cached prefix, so Riki
 * forgets who it is before it forgets what it just said.
 *
 * See docs/design/voice-input-architecture.md §5.6. Declarations only.
 */

import type { ItemId, MonoMs, Unsubscribe } from './types.js';

/**
 * ⚠ `packages/context` owns all four of these (`LedgerRef`, `WindowPlan`, `AppliedWindowPlan`,
 * `DropReason`) and this package mirrors the fields it needs. The plan crosses as a value, which
 * is exactly why neither half has to be testable in the other's terms. Replaced by an import at
 * step 7.
 */
export type LedgerRef = number & { readonly __brand: 'LedgerRef' };

export type DropReason = 'planned' | 'api_truncation' | 'session_lost';

export interface WindowPlan {
  readonly drop: readonly LedgerRef[];
  readonly replace: readonly {
    readonly refs: readonly LedgerRef[];
    readonly with: { readonly text: string; readonly tokens: number };
  }[];
  readonly estimatedTokensAfter: number;
  readonly reason: 'low_water' | 'quiet_moment' | 'forced';
}

export interface AppliedWindowPlan {
  readonly dropped: readonly LedgerRef[];
  /** A delete the API refuses is a failed ref, not an exception. Nothing here throws. */
  readonly failed: readonly LedgerRef[];
}

export interface WindowUsage {
  readonly reportedTokens: number;
  readonly at: MonoMs;
}

export interface ContextWindowExecutor {
  apply(plan: WindowPlan): Promise<AppliedWindowPlan>;
  onDropped(listener: (refs: readonly LedgerRef[], reason: DropReason) => void): Unsubscribe;
  usage(): WindowUsage | null;
  /** The mapping the ledger deliberately does not hold: a ledger position to a wire item id. */
  bind(ref: LedgerRef, item: ItemId): void;
}

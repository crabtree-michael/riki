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
 * See docs/design/voice-input-architecture.md §5.6.
 */

import type { ItemId, MonoMs, Unsubscribe } from './types.js';
import type { ClientEvent } from './wire.js';

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

// -----------------------------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------------------------

export interface ContextWindowExecutorDeps {
  readonly send: (event: ClientEvent) => void;
}

/**
 * The write side, held by the session.
 *
 * `packages/context` gets a `ContextWindowExecutor` and cannot reach these: it plans, it does not
 * report. Usage and API-initiated truncation are things only the wire observes.
 */
export interface ContextWindowController extends ContextWindowExecutor {
  /** From `response.done`. The only source of `usage()`; nothing else may set it. */
  noteUsage(tokens: number, at: MonoMs): void;
  /**
   * The API dropped context before we did.
   *
   * Context §6 calls a non-zero count here a bug rather than a condition, and it is: it means our
   * accounting let the API reach the ceiling first, and the API truncates oldest-first — which
   * takes the cached prefix, so Riki forgets who it is before it forgets what it just said.
   */
  noteApiTruncation(refs: readonly LedgerRef[]): void;
  /** Session lost: everything bound is gone, and the refs need reporting as such. */
  noteSessionLost(): void;
}

/**
 * A system message rather than an assistant one, deliberately: the model must not come to believe
 * it *said* the summary. That would be a subtler version of the barge-in failure — a false memory
 * of its own speech, which every later turn then reasons from.
 */
function summaryItem(text: string): ClientEvent {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text }],
    },
  };
}

export function createContextWindowExecutor(
  deps: ContextWindowExecutorDeps,
): ContextWindowController {
  const items = new Map<LedgerRef, ItemId>();
  const listeners = new Set<(refs: readonly LedgerRef[], reason: DropReason) => void>();
  let reported: WindowUsage | null = null;

  const announce = (refs: readonly LedgerRef[], reason: DropReason): void => {
    if (refs.length === 0) return;
    for (const listener of listeners) listener(refs, reason);
  };

  return {
    bind(ref, item) {
      items.set(ref, item);
    },

    apply(plan: WindowPlan): Promise<AppliedWindowPlan> {
      const dropped: LedgerRef[] = [];
      const failed: LedgerRef[] = [];

      // Summaries first, then deletions. The opposite order leaves a window that has forgotten a
      // stretch of the match and does not yet hold its replacement — a gap the model will
      // confidently reason across.
      for (const replacement of plan.replace) {
        deps.send(summaryItem(replacement.with.text));
      }

      for (const ref of plan.drop) {
        const item = items.get(ref);
        if (item === undefined) {
          // Nothing bound means the entry never became a conversation item, so there is nothing
          // on the wire to delete. Dropped, not failed.
          dropped.push(ref);
          continue;
        }
        try {
          deps.send({ type: 'conversation.item.delete', item_id: item });
          items.delete(ref);
          dropped.push(ref);
        } catch {
          // "A delete the API refuses is a failed ref, not an exception. Nothing here throws."
          failed.push(ref);
        }
      }

      announce(dropped, 'planned');
      return Promise.resolve({ dropped, failed });
    },

    onDropped(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Never an estimate — see the header. `null` until the session has reported something. */
    usage() {
      return reported;
    },

    noteUsage(tokens, at) {
      reported = { reportedTokens: tokens, at };
    },

    noteApiTruncation(refs) {
      for (const ref of refs) items.delete(ref);
      announce(refs, 'api_truncation');
    },

    noteSessionLost() {
      const lost = [...items.keys()];
      items.clear();
      announce(lost, 'session_lost');
    },
  };
}

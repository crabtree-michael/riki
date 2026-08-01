/**
 * The conversation ledger — ADR-0012.
 *
 * Append-only, in memory, one per match. A whole match is a few hundred entries and a few tens of
 * kilobytes of text, so there is nothing clever here and nothing should become clever: the value is
 * entirely in the invariants.
 *
 * Three of them, and each is load-bearing somewhere else:
 *
 * - **`markDropped` never mutates an entry.** Compaction changes what the *model* can see; it does
 *   not change what happened. That is why every projection over the ledger (coaching memory, the
 *   summary, the rehydration brief) survives a compaction unchanged, and it is the whole reason the
 *   novelty gate is correct across one.
 * - **Only window-bearing entries are ever `inWindow`.** `turn_opened` and `turn_closed` are our
 *   bookkeeping and are never sent to the model, so counting them as occupancy would inflate our
 *   estimate of the window — the exact drift §7.6 exists to catch, manufactured by us.
 * - **`version()` is monotonic and bumps on drops as well as appends**, because a projection that
 *   memoised only against appends would go stale the moment a compaction changed what is visible.
 *
 * See docs/design/context-and-memory-architecture.md §6.2.
 */

import type { MatchId } from '../common/types.js';
import type { ConversationLedger } from './contracts.js';
import type { DropReason, LedgerEntry, LedgerRef } from './types.js';

/**
 * Entry kinds that occupy space in the model's context window.
 *
 * The two absentees are deliberate: a turn opening and a turn closing are things Riki records about
 * itself. `turn_closed: 'silent'` in particular is a turn the model never heard about at all.
 */
export const WINDOW_BEARING: ReadonlySet<LedgerEntry['kind']> = new Set([
  'snapshot',
  'agent_said',
  'player_said',
  'command',
  'summary',
] as const);

export function isWindowBearing(entry: LedgerEntry): boolean {
  return WINDOW_BEARING.has(entry.kind);
}

/** Counts by reason, for §7.6: a non-zero `api_truncation` is a bug, not a condition. */
export interface DropCounts {
  readonly planned: number;
  readonly api_truncation: number;
  readonly session_lost: number;
}

export interface MatchLedger extends ConversationLedger {
  /** Everything, in order, whatever its window state. The projection primitive's raw form. */
  all(): readonly LedgerEntry[];
  dropped(): DropCounts;
  /** Why a ref left the window, when it did. Absent means still believed visible. */
  dropReason(ref: LedgerRef): DropReason | undefined;
}

export function createConversationLedger(matchId: MatchId): MatchLedger {
  const entries: LedgerEntry[] = [];
  const drops = new Map<LedgerRef, DropReason>();
  const counts = { planned: 0, api_truncation: 0, session_lost: 0 };
  let version = 0;

  return {
    matchId,

    append(entry: LedgerEntry): LedgerRef {
      const ref = entries.length as LedgerRef;
      entries.push(entry);
      version += 1;
      return ref;
    },

    /**
     * Inclusive of `ref`, so `since(0)` is the whole match.
     *
     * The alternative — exclusive, "everything after" — makes the natural call for a full
     * projection `since(-1)`, which is a ref that cannot exist and would have to be special-cased
     * by every caller.
     */
    since(ref: LedgerRef): readonly LedgerEntry[] {
      return entries.slice(Math.max(0, ref));
    },

    entry(ref: LedgerRef): LedgerEntry | undefined {
      return entries[ref];
    },

    inWindow(): readonly LedgerRef[] {
      const out: LedgerRef[] = [];
      for (const [index, entry] of entries.entries()) {
        const ref = index as LedgerRef;
        if (isWindowBearing(entry) && !drops.has(ref)) out.push(ref);
      }
      return out;
    },

    markDropped(refs: readonly LedgerRef[], reason: DropReason): void {
      let changed = false;
      for (const ref of refs) {
        if (drops.has(ref)) continue;
        drops.set(ref, reason);
        counts[reason] += 1;
        changed = true;
      }
      // A re-report of the same drop is not a version bump: `packages/realtime` may confirm a plan
      // this component already applied, and a projection recomputing for that is pure waste.
      if (changed) version += 1;
    },

    version(): number {
      return version;
    },

    all(): readonly LedgerEntry[] {
      return entries;
    },

    dropped(): DropCounts {
      return { ...counts };
    },

    dropReason(ref: LedgerRef): DropReason | undefined {
      return drops.get(ref);
    },
  };
}

/**
 * The truncation order, as data.
 *
 * §5.2's table, one row per line group, and the reason it is a table rather than the order of
 * statements in a render function: *a section with no declared priority truncates in whatever order
 * an array happened to be in*, which is not a design decision anybody made and is not reviewable as
 * a diff.
 *
 * One rule here is not obvious from the table and is the one an implementation gets wrong:
 * **`seen` and `unseen` drop together.** `unseen >20s: ws, zeus` alone reads as a complete account
 * of where the enemy team is, which is the opposite of what it says. `dropsWith` is the closure
 * that makes that structural.
 *
 * The second rule used to be about promotion — a turn's cause moved one section up the ladder, and
 * a promotion had to move the whole drop-group or it would cause the drop it existed to prevent.
 * ADR-0042 removed the cause that could do it. See `contracts.ts`.
 *
 * See docs/design/context-and-memory-architecture.md §5.2.
 */

import type { PriorityLadder } from './contracts.js';
import type { LadderEntry, SnapshotSectionId } from './types.js';

/**
 * §5.2's table. Output order follows this array; truncation order follows `priority`.
 *
 * The first five are `droppable: false` — dota2 §6.2's "self-state and enemy state never get
 * truncated". The composer cannot drop them, so a budget too small to hold them produces a
 * `truncated` snapshot that still has a hero in it rather than one that does not.
 */
export const SNAPSHOT_LADDER: readonly LadderEntry[] = [
  { id: 'header', priority: 100, droppable: false },
  { id: 'self_economy', priority: 90, droppable: false },
  { id: 'self_abilities', priority: 80, droppable: false },
  { id: 'self_items', priority: 70, droppable: false },
  { id: 'enemies', priority: 60, droppable: false },
  { id: 'seen', priority: 50, droppable: true, dropsWith: ['unseen'] },
  { id: 'unseen', priority: 45, droppable: true, dropsWith: ['seen'] },
  { id: 'derived', priority: 40, droppable: true },
  { id: 'map', priority: 30, droppable: true },
];

export function createPriorityLadder(
  entries: readonly LadderEntry[] = SNAPSHOT_LADDER,
): PriorityLadder {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  return {
    entries,

    /**
     * Transitive, because a `dropsWith` chain of three would otherwise drop two and keep the third
     * — the same "one without the other" failure the pairing exists to prevent, one link along.
     */
    closure(dropping: readonly SnapshotSectionId[]): readonly SnapshotSectionId[] {
      const out = new Set<SnapshotSectionId>();
      const pending = [...dropping];
      while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined || out.has(id)) continue;
        out.add(id);
        for (const also of byId.get(id)?.dropsWith ?? []) pending.push(also);
      }
      return [...out];
    },
  };
}

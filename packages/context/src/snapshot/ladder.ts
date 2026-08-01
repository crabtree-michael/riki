/**
 * The truncation order, as data.
 *
 * §5.2's table, one row per line group, and the reason it is a table rather than the order of
 * statements in a render function: *a section with no declared priority truncates in whatever order
 * an array happened to be in*, which is not a design decision anybody made and is not reviewable as
 * a diff.
 *
 * Two rules here are not obvious from the table and are the ones an implementation gets wrong:
 *
 * - **`seen` and `unseen` drop together.** `unseen >20s: ws, zeus` alone reads as a complete account
 *   of where the enemy team is, which is the opposite of what it says. `dropsWith` is the closure
 *   that makes that structural.
 * - **A promotion moves the whole drop-group.** Promoting `seen` without `unseen` would leave
 *   `unseen` at the bottom of the ladder, dropped first, and the closure would then take `seen` with
 *   it — so the promotion would have caused the drop it existed to prevent.
 *
 * See docs/design/context-and-memory-architecture.md §5.2.
 */

import type { EventId } from '../common/types.js';
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
  { id: 'recent', priority: 20, droppable: true },
];

/**
 * The turn's cause promotes **exactly one** section, by lookup rather than by scoring.
 *
 * The turn exists because of that event; the section that explains it should not be what the budget
 * eats. A lookup table keeps the resulting order a golden-testable fact — a scoring function would
 * make "why did `map` survive and `derived` not" a question with a numeric answer nobody can
 * predict from the fixture.
 *
 * Event ids are `packages/events`' vocabulary (dota2 §6.4); unknown ones promote nothing, which is
 * the correct behaviour for an event this table has not heard of.
 */
export const PROMOTION_BY_EVENT: ReadonlyMap<string, SnapshotSectionId> = new Map([
  ['rune_soon', 'derived'],
  ['roshan_window', 'derived'],
  ['can_afford_key_item', 'derived'],
  ['power_spike', 'derived'],
  ['enemy_missing', 'seen'],
  ['smoke_detected', 'seen'],
  ['gank_risk', 'seen'],
  ['tower_threat', 'map'],
  ['objective_available', 'map'],
] as const);

export function createPriorityLadder(
  entries: readonly LadderEntry[] = SNAPSHOT_LADDER,
): PriorityLadder {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  return {
    entries,

    promote(cause: EventId): SnapshotSectionId | null {
      return PROMOTION_BY_EVENT.get(String(cause)) ?? null;
    },

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

/**
 * The ladder with one section moved to the top of the droppable group, and its drop-group with it.
 *
 * "Top of the droppable group" rather than "above everything": the five undroppable sections are
 * undroppable, so promoting past them would change output order for no benefit. Promotion only ever
 * changes what the *budget* eats.
 */
export function promoted(
  entries: readonly LadderEntry[],
  section: SnapshotSectionId | null,
  ladder: PriorityLadder,
): readonly LadderEntry[] {
  if (section === null) return entries;
  const group = new Set(ladder.closure([section]));

  const droppableTop = entries
    .filter((entry) => entry.droppable && !group.has(entry.id))
    .reduce((max, entry) => Math.max(max, entry.priority), 0);

  // The group keeps its internal order above the rest of the droppable set, so promoting `seen`
  // still renders `seen` before `unseen`.
  let offset = group.size;
  return entries.map((entry) => {
    if (!group.has(entry.id)) return entry;
    offset -= 1;
    return { ...entry, priority: droppableTop + 1 + offset };
  });
}

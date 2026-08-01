/**
 * Tier 2 — the ~300-token snapshot the agent sees at the start of every turn (dota2 §6.2).
 *
 * The format is the interface to the LLM: it goes through `fixtures/golden/snapshot/` and the diff
 * is the review. Architecture: docs/design/context-and-memory-architecture.md §5.
 *
 * `createSnapshotRenderer()` is what the composition root takes; everything else is exported for
 * tests and for a caller that wants to render with a different ladder.
 */

export type * from './types.js';
export type * from './contracts.js';

export { createSnapshotRenderer, isEmpty } from './renderer.js';
export type { SnapshotRendererOptions } from './renderer.js';
export { SNAPSHOT_LADDER, PROMOTION_BY_EVENT, createPriorityLadder, promoted } from './ladder.js';
export { elide } from './elision.js';
export { ALL_SECTIONS, MAX_TAPE_EVENTS, UNSEEN_AFTER_SECONDS } from './sections/index.js';

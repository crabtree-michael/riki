/**
 * The rendering primitives, shared by all three tiers.
 *
 * There are two renderers in this package — the Tier 2 snapshot and the Tier 3 result renderer —
 * and the rules they obey are the same rules: a stale fact renders with its age and confidence or
 * it does not render, below-threshold facts are dropped rather than hedged, and truncation is
 * priority-ordered and recorded. These are the three functions that make that true once.
 *
 * See docs/design/context-and-memory-architecture.md §5.1. Declarations only so far.
 */

export type * from './types.js';
export type * from './contracts.js';

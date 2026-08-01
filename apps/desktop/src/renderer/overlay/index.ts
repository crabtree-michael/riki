/**
 * The chip: states, motion, and level bars. Click-through layered window with per-pixel alpha.
 *
 * Colours come from the design token module, never from literals — a lint rule enforces it so
 * the "no red" rule has one place to live (§6.2).
 *
 * The architecture — how this view is driven, and why the state that drives it is not in here —
 * is docs/design/overlay-architecture.md §7. The contracts below are the pure parts; the views
 * themselves land when step 6 splits this app into main / preload / renderer TypeScript
 * projects (§11.3 of that document).
 *
 * Skeleton only — no implementation yet.
 */

export type * from './contracts.js';

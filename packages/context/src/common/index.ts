/**
 * The vocabulary and the read interface every tier of this package shares.
 *
 * Everything here is transitional in the same sense: it belongs to `@riki/protocol` (step 2) or to
 * `@riki/world-model` (step 4), both of which are still empty. Collecting it in one place is what
 * makes adopting those packages a single-file change rather than one per tier.
 *
 * See docs/design/context-and-memory-architecture.md §3 and §11.
 */

export type * from './types.js';
export type * from './ports.js';

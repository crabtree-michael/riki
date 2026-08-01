/**
 * Memory — four spans, from one turn to across matches.
 *
 * The model's context window truncates oldest-first, cannot be enumerated, and dies with the
 * session (realtime §5), so it is a cache of the tail of the ledger rather than a record. ADR-0012
 * is that decision; ADR-0013 constrains what may persist across matches.
 *
 * Architecture: docs/design/context-and-memory-architecture.md §6 and §7. Declarations only.
 */

export type * from './types.js';
export type * from './ports.js';
export type * from './contracts.js';

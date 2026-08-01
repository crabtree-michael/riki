/**
 * Tier 2 — the ~300-token snapshot the agent sees at the start of every turn (dota2 §6.2).
 *
 * The format is the interface to the LLM: it goes through `fixtures/golden/` and the diff is the
 * review. Architecture: docs/design/context-and-memory-architecture.md §5. Declarations only.
 */

export type * from './types.js';
export type * from './contracts.js';

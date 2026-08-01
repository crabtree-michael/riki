/**
 * Tier 1 — the session preamble, written once and frozen into the cached prefix (dota2 §6.1).
 *
 * Architecture: docs/design/context-and-memory-architecture.md §4.
 */

export type * from './types.js';
export type * from './contracts.js';

export { createPreambleAssembler, DEFAULT_ENRICHMENT_DEADLINE_MS } from './assemble.js';
export type { PreambleAssemblerOptions } from './assemble.js';
export { createEnrichmentPlanner, BENCHMARK_AT } from './enrichment.js';
export { createPrefixBudget, PREFIX_ALLOCATION, PREFIX_CAP_TOKENS } from './budget.js';
export { ALL_PREAMBLE_SECTIONS } from './sections/index.js';
export type { Enrichment, PreambleSectionSource } from './sections/index.js';

/**
 * Reference data — the data that is not about this match.
 *
 * `agent-command-execution-architecture.md` §5.3 already named this category and gave it a port;
 * what lives here are the implementations of it that `packages/context` owns outright. Today that
 * is the hero library and nothing else. Item costs, matchups and build benchmarks still come from
 * whatever the composition root wires into `ReferenceDataPort`, and are still fakes.
 *
 * Nothing here reads the world model, a clock or a source. It is content plus a pure query over it.
 */

export * from './hero-library/index.js';

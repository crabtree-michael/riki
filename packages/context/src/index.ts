/**
 * @riki/context
 *
 * What the agent sees, and what Riki remembers.
 *
 * Three tiers of context (dota2 §6): the session preamble written once into the cached prefix, the
 * ~300-token snapshot rendered per turn, and the tool surface the agent pulls detail through. Plus
 * a memory layer underneath all three, because the model's context window truncates oldest-first,
 * cannot be enumerated, and dies with the session — so it is a cache of the tail of Riki's own
 * conversation ledger rather than a record of it (ADR-0012).
 *
 * Both rendered formats are interfaces to the LLM, so they are golden-tested against
 * `fixtures/golden/` — a format change should show up as a readable diff.
 *
 * Architecture: docs/design/context-and-memory-architecture.md (Tiers 1 and 2, and memory) and
 * docs/design/agent-command-execution-architecture.md (Tier 3).
 *
 * `createContextAssembler()` is the one runtime surface (§9.4). Everything else is exported for the
 * composition root's own wiring and for tests; nothing outside this package should need to
 * construct a renderer, a ledger or a retention policy by hand.
 *
 * See REPO_SKELETON.md §2.2 for what belongs here and §10 for where this package sits in the
 * scaffolding order.
 */

export type * from './common/index.js';
export * from './render/index.js';
export * from './preamble/index.js';
export * from './snapshot/index.js';
export * from './memory/index.js';
export * from './tools/index.js';
export * from './assembler.js';

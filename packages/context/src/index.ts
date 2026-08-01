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
 * docs/design/agent-command-execution-architecture.md (Tier 3). No behaviour has landed anywhere in
 * this package yet; see REPO_SKELETON.md §2.2 for what belongs here and §10 for where this package
 * sits in the scaffolding order.
 */

export type * from './common/index.js';
export type * from './render/index.js';
export type * from './preamble/index.js';
export type * from './snapshot/index.js';
export type * from './memory/index.js';
export type * from './tools/index.js';
export type * from './assembler.js';

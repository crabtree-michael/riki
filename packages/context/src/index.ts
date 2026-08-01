/**
 * @riki/context
 *
 * What the agent actually sees: the ~300-token snapshot (Tier 2), the tool surface the agent can
 * call (Tier 3), and the session preamble (Tier 1).
 *
 * The snapshot format is the interface to the LLM, so it is golden-tested against
 * fixtures/golden/ — a format change should show up as a readable diff.
 *
 * Tier 3 has a module and class architecture, and its contracts are declared in `./tools`
 * (docs/design/agent-command-execution-architecture.md). Tiers 1 and 2 are still skeleton, and no
 * behaviour has landed anywhere in this package. See REPO_SKELETON.md §2.2 for what belongs here
 * and §10 for where this package sits in the scaffolding order.
 */

export type * from './tools/index.js';

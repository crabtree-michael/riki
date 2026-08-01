/**
 * Tier 3 — the command surface the agent can call (dota2-state-capture-design.md §6.3).
 *
 * Detail the agent pulls when it needs it, which is what keeps the Tier 2 snapshot small. A command
 * reads what has already been observed; nothing here reaches into the game (ADR-0003).
 *
 * Architecture: docs/design/agent-command-execution-architecture.md. Declarations only so far.
 */

export type * from './types.js';
export type * from './ports.js';
export type * from './contracts.js';

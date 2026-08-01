/**
 * The rendering primitives, shared by all three tiers.
 *
 * There are two renderers in this package — the Tier 2 snapshot and the Tier 3 result renderer —
 * and the rules they obey are the same rules: a stale fact renders with its age and confidence or
 * it does not render, below-threshold facts are dropped rather than hedged, and truncation is
 * priority-ordered and recorded. These are the three functions that make that true once.
 *
 * The implementations landed with Tier 3 rather than after it, because
 * `agent-command-execution-architecture.md` §16 step 3 warns that two renderers written months
 * apart agree until the day one of them learns to say "probably". **Tier 2 composes these; it does
 * not write its own.**
 *
 * See docs/design/context-and-memory-architecture.md §5.1.
 */

export type * from './types.js';
export type * from './contracts.js';

export { createTokenCounter, estimateTokens } from './tokens.js';
export { createAgeFormatter, renderObserved, DEFAULT_AGE_OPTIONS } from './age.js';
export type { AgeFormatterOptions } from './age.js';
export { createPrivacyGate, classifyField, DEFAULT_PRIVACY } from './privacy.js';
export { createSectionComposer } from './compose.js';

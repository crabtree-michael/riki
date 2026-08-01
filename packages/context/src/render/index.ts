/**
 * The rendering primitives, shared by all three tiers.
 *
 * There are two renderers in this package — the Tier 2 snapshot and the Tier 3 result renderer —
 * and the rules they obey are the same rules: a stale fact renders with its age and confidence or
 * it does not render, below-threshold facts are dropped rather than hedged, and truncation is
 * priority-ordered and recorded. These are the three functions that make that true once.
 *
 * The implementations landed before either renderer needed a second one, and that ordering was
 * the point: two renderers written months apart agree until the day one of them learns to say
 * "probably". **The snapshot and the coaching brief both compose these; neither writes its own.**
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

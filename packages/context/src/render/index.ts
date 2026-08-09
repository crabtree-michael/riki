/**
 * The rendering primitives.
 *
 * The rules they encode are the ones every rendering of a game fact must obey: a stale fact renders
 * with its age and confidence or it does not render, below-threshold facts are dropped rather than
 * hedged, and truncation is priority-ordered and recorded. These are the functions that make that
 * true once.
 *
 * There is one renderer left in this package rather than three, and these still do not live inside
 * it. The reason is the one that made them separate in the first place: two renderers written
 * months apart agree until the day one of them learns to say "probably", and the tool layer
 * (conversational-architecture.md §5) is the next thing that has to render an `Observed<T>`.
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

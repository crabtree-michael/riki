/**
 * @riki/world-model
 *
 * The single model of the match, fused from GSI, CV, and the log tail.
 *
 * Fusion precedence, staleness decay, confidence, provenance, derived state, and ring history
 * live here. Pure functions over data: no I/O, no Electron, testable in milliseconds.
 *
 * It must not know it is feeding an LLM — state and conversation rates are decoupled by
 * design, and a lint boundary stops it importing @riki/realtime (§6.2).
 *
 * Contracts only — no behaviour yet. Every `declare`d function is a signature waiting for
 * REPO_SKELETON.md §10 step 4; the shapes are docs/design/state-capture-architecture.md §3 and §5,
 * and the seam they all serve is ADR-0014.
 */

export type * from './time.js';
export type * from './fact.js';
export type * from './observation.js';
export type * from './state.js';
export type * from './snapshot.js';
export type * from './store.js';
export type * from './drift.js';
export type * from './fusion/reducer.js';
export type * from './fusion/precedence.js';
export type * from './fusion/confidence.js';
export type * from './fusion/staleness.js';
export type * from './derived/registry.js';
export type * from './history/ring.js';
export type * from './history/delta.js';

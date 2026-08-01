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
 * Skeleton only — no implementation yet. See REPO_SKELETON.md §2.2 for what belongs here
 * and §10 for where this package sits in the scaffolding order.
 */

export {};

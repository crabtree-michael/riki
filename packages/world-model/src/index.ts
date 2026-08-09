/**
 * @riki/world-model
 *
 * The single model of the match, fused from GSI, CV, and the log tail.
 *
 * Fusion precedence, staleness decay, confidence, provenance, derived state, and ring history
 * live here. Pure functions over data: no I/O, no Electron, testable in milliseconds.
 *
 * **One exception, and it is exactly one file.** `record/file-sink.ts` appends a match recording to
 * disk. The recorder itself is pure over an injected `RecordSink`; the descriptor lives there and
 * nowhere else, because the app, the timeline reader and `tools/` all have to write and read the
 * same bytes and a second implementation would be a second format (ADR-0044).
 *
 * It must not know it is feeding an LLM — state and conversation rates are decoupled by
 * design, and a lint boundary stops it importing @riki/realtime (§6.2).
 *
 * `tools/` and `timeline/` make that rule worth restating, because between them they gave this
 * package its first outward dependency: they answer the five tools, whose argument and result
 * shapes are @riki/protocol's (ADR-0042). That is a *shape*, declared at a boundary, the same way
 * the sidecar's detections are — it is not a session, a prompt or a turn, and nothing here may
 * reach for one. @riki/protocol is the only dependency this package has, and the boundary rule is
 * what keeps the list at one.
 *
 * The shapes are docs/design/state-capture-architecture.md §3 and §5, and the seam they all serve
 * is ADR-0014. `createWorldModelStore` is the only entry point most callers need; everything else
 * is exported so a test can construct one piece without the rest.
 */

export * from './time.js';
export * from './fact.js';
export type * from './observation.js';
export * from './state.js';
export * from './snapshot.js';
export * from './store.js';
export * from './drift.js';
export * from './fusion/candidate.js';
export * from './fusion/reducer.js';
export * from './fusion/precedence.js';
export * from './fusion/confidence.js';
export * from './fusion/staleness.js';
export * from './fusion/read-cv.js';
export * from './fusion/read-gsi.js';
export * from './fusion/read-log.js';
export * from './derived/registry.js';
export * from './derived/rules/index.js';
export * from './history/ring.js';
export * from './history/delta.js';
export * from './record/index.js';
export * from './tools/index.js';
export * from './timeline/index.js';

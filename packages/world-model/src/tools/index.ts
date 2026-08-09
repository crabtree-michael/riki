/**
 * The four live tools, as pure functions from a `ToolContext` to `packages/protocol`'s result
 * shapes (ADR-0042 T3). `world_at` is the fifth and reads a recording rather than a live state, so
 * it lives in `timeline/` and reuses these shapes.
 *
 * Nothing here dispatches. A tool name arrives as a string from a language model, and turning that
 * string into one of these calls is `packages/realtime`'s job — this package may not import it, and
 * a dispatch table here would be the seam moving to the wrong side of the boundary (§6.2).
 */

export * from './context.js';
export * from './my-state.js';
export * from './enemy.js';
export * from './objectives.js';
export * from './economy.js';
export * from './buildings.js';

/**
 * Types shared between main and renderer only.
 *
 * Anything crossing a process or language boundary belongs in @riki/protocol instead (§4).
 *
 * The overlay's vocabulary lives here for now, including three types that will move to
 * @riki/protocol when step 2 lands — docs/design/overlay-architecture.md §6.3 says why.
 *
 * The **voice** window's messages have already moved: they are `@riki/protocol`'s
 * `schemas/voice.ts`. What is left here for it is `voice-channels.ts`, two channel names — a
 * string main and the preload agree on is not a message, and `shared/` may not import a package.
 */

export type * from './overlay.js';
export type * from './debug.js';
export { DEBUG_LIMITS, DEBUG_FRAME_INTERVAL_MS } from './debug.js';
export * from './channels.js';
export * from './voice-channels.js';

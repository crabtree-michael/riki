/**
 * Types shared between main and renderer only.
 *
 * Anything crossing a process or language boundary belongs in @riki/protocol instead (§4).
 *
 * The overlay's vocabulary lives here for now, including three types that will move to
 * @riki/protocol when step 2 lands — docs/design/overlay-architecture.md §6.3 says why.
 */

export type * from './overlay.js';
export * from './channels.js';

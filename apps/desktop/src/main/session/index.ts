/**
 * The interaction machine and its runtime.
 *
 * `machine` is pure and has never heard of Electron, @riki/realtime or @riki/audio — the adapters
 * in main/adapters exist to hold those imports (docs/design/overlay-architecture.md §5.6).
 */

export * from './contracts.js';
export * from './types.js';
export {
  ACCENTS,
  GLYPHS,
  MOTIONS,
  chipStateOf,
  initial,
  machine,
  projectChip,
  projectTray,
  reduce,
} from './machine.js';
export { createSessionRuntime } from './runtime.js';
export {
  CANCEL_HINT_MS,
  DEFAULT_ENVIRONMENT,
  ELAPSED_HINT_MS,
  ENTER_MS,
  ERROR_DISMISS_MS,
  HIDE_HOLD_MS,
} from './timing.js';

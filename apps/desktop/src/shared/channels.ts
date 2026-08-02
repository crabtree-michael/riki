/**
 * The IPC channel names.
 *
 * Here rather than in `preload/` because main and preload both have to agree on them, and
 * `shared/` is the one place both can read from without crossing a boundary. Two channels out,
 * one in — docs/design/overlay-architecture.md §6.1.
 *
 * A value, not a type, so this file is exported separately from the type-only barrel.
 *
 * **Each window gets its own bridge key and its own channels.** They are separate namespaces
 * rather than one wider surface because each renderer should be able to see only what it needs:
 * the overlay has no business reading a `DebugFrame`, and the inspector has no business sending a
 * `cancel` intent into the interaction machine.
 */

/** The one global the preload bridge adds to the overlay renderer's window. */
export const OVERLAY_BRIDGE_KEY = 'rikiOverlay';

export const OVERLAY_CHANNELS = {
  /** main → renderer, on change: a chip model, an environment, or a teardown. */
  command: 'riki:overlay:command',
  /** main → renderer, ≤30 Hz and only while visible. */
  level: 'riki:overlay:level',
  /** renderer → main, rare, and validated against an allow-list before it goes anywhere. */
  intent: 'riki:overlay:intent',
} as const;

/** The dev-only inspector window's global. Absent unless `config.debug.enabled`. */
export const DEBUG_BRIDGE_KEY = 'rikiDebug';

export const DEBUG_CHANNELS = {
  /** main → renderer, 4 Hz while the window is open: a whole `DebugFrame`, or a teardown. */
  command: 'riki:debug:command',
  /**
   * renderer → main. Four members: `ready`, `fault`, and the two that move a setting (ADR-0037).
   *
   * Validated against `parseDebugIntent` at both ends, and a `control` is validated a second time
   * in main against the registry — shape is not authority.
   */
  intent: 'riki:debug:intent',
} as const;

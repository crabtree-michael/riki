/**
 * The overlay's IPC channel names.
 *
 * Here rather than in `preload/` because main and preload both have to agree on them, and
 * `shared/` is the one place both can read from without crossing a boundary. Two channels out,
 * one in — docs/design/overlay-architecture.md §6.1.
 *
 * A value, not a type, so this file is exported separately from the type-only barrel.
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

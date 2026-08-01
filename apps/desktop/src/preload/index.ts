/**
 * The only bridge between main and renderer. contextIsolation stays on and the renderer gets no
 * Node access.
 *
 * Nothing secret crosses here — the API key is resolved in main by @riki/config and never
 * reaches the renderer (§7.1).
 *
 * Skeleton only — no implementation yet.
 */

export {};

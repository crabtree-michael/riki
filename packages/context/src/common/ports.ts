/**
 * The read interface every tier of this package consumes, and the only way a game fact gets in.
 *
 * state-capture-architecture.md §7.1, imported unchanged in spirit. **No tier reads a source** —
 * not GSI, not the log tailer, not the sidecar. Everything this package can know has been through
 * fusion, precedence, the confidence gate and ageing exactly once, which is the only way those
 * policies actually reach the agent.
 *
 * ⚠ Transitional. `packages/world-model` (REPO_SKELETON.md §10 step 4) owns these and is still
 * empty, so the parts this package consumes are declared structurally here. When it lands, this
 * file imports them and deletes its copies.
 */

import type { GameClock, MonoMs, Unsubscribe } from './types.js';

/** Opaque here. `packages/world-model` owns its shape; this package only reads through it. */
export interface WorldSnapshot {
  readonly version: number;
  readonly now: MonoMs;
  readonly clock: GameClock | null;
}

export interface WorldDelta {
  readonly fromVersion: number;
  readonly toVersion: number;
}

export interface WorldModelReader {
  snapshot(now: MonoMs): WorldSnapshot;
  onVersion(listener: (version: number, delta: WorldDelta) => void): Unsubscribe;
  /** Used by the `recent:` fallback and by the summary renderer (architecture §7.4, §8.1). */
  history(since: GameClock): readonly WorldDelta[];
}

/**
 * `console.*` is confined to `packages/telemetry` (REPO_SKELETON.md §6.2), which is why this is a
 * port rather than a logger. Nothing here carries rendered text: telemetry counts and times, and
 * the golden corpus is where output is inspected.
 */
export interface ContextTelemetry {
  noteRender(tier: 'preamble' | 'snapshot' | 'summary', elapsedMs: number, tokens: number): void;
  noteTruncation(tier: string, omitted: readonly string[]): void;
  noteCompaction(reason: string, droppedTokens: number, estimatedAfter: number): void;
  /** The §7.6 drift signal: our estimate versus what the session actually reports. */
  noteWindowDrift(estimated: number, reported: number): void;
}

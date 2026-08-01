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

import type { GameClock, HeroId, MonoMs, Observed, Unsubscribe } from './types.js';

/** A dotted path into the world state, e.g. `self.hp` or `enemies.sf.position`. */
export type FieldPath = string & { readonly __brand: 'FieldPath' };

/**
 * The draft, as this package needs it. Tier 3 resolves a spoken hero name against it so that
 * `get_enemy_detail("pudge")` in a game with no Pudge answers "Pudge isn't in this game" rather
 * than describing a hero nobody is playing (command architecture §4.3).
 */
export interface Roster {
  readonly self: HeroId | undefined;
  readonly allies: readonly HeroId[];
  readonly enemies: readonly HeroId[];
}

/**
 * The read view. `packages/world-model` owns its real shape; this is the part this package reads.
 *
 * The load-bearing detail is `get()`: it hands back the fact *with* its staleness, confidence and
 * provenance, and there is no accessor that returns a bare `T`. That is mildly annoying at every
 * call site, which is the intended effect — it is what makes "a stale CV fact renders with its age
 * or it does not render" (dota2 §4 rule 3) structural rather than remembered.
 *
 * Mirrors `WorldSnapshot` in packages/world-model/src/snapshot.ts, except that reads come back as
 * `Observed<T>` rather than that package's `StaleFact<T>`. The two carry the same information;
 * collapsing them is one adapter in the composition root when step 4 lands, and §11 of the command
 * architecture records it.
 */
export interface WorldSnapshot {
  readonly version: number;
  readonly now: MonoMs;
  readonly clock: GameClock | null;
  get<T>(path: FieldPath): Observed<T> | undefined;
  roster(): Roster;
  /** Drives `unseen >20s:` — heroes with no fresh position, which is not the same as absent ones. */
  unseenFor(seconds: number): readonly HeroId[];
}

/** One field's movement between two versions. `undefined` on either side means never-observed. */
export interface FieldChange {
  readonly path: FieldPath;
  readonly before: Observed<unknown> | undefined;
  readonly after: Observed<unknown> | undefined;
}

export interface WorldDelta {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly atGameClock: GameClock | null;
  readonly changes: readonly FieldChange[];
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

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

import type { GameClock, HeroId, MonoMs, Observed, RegionId, Unsubscribe } from './types.js';

/** A dotted path into the world state, e.g. `self.hp` or `enemies.sf.position`. */
export type FieldPath = string & { readonly __brand: 'FieldPath' };

/** The draft, as this package needs it — read by the snapshot's `enemies` and `seen` sections. */
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

// -----------------------------------------------------------------------------------------------
// The one outbound port
// -----------------------------------------------------------------------------------------------

/**
 * The sidecar control channel — state-capture-architecture.md §4.3, and **owned there**.
 *
 * `requestRegion` resolves with a request id, **not** with detections: the detections arrive by the
 * normal observation path and land in the model like everything else. A caller that pulled results
 * straight back would be a second way for a CV fact to reach the agent — one with no precedence, no
 * confidence gate and no age.
 *
 * ⚠ Transitional, and currently **unconsumed inside this package**. It is declared here as a
 * structural mirror pending `packages/protocol`, and `crates/riki-vision` is the other end.
 */
export interface CapturePort {
  requestRegion(region: RegionId, opts: { timeoutMs: number }): Promise<RequestId>;
}

export type RequestId = string & { readonly __brand: 'RequestId' };

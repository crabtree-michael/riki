/**
 * What every detector shares: how to read a fact, how to carry its confidence, and the three
 * things more than one of them needs to know about the world.
 *
 * Two rules hold this directory together and both are `coaching-trigger-architecture.md` §3.1's:
 *
 * - **A detector is a pure function of the snapshot.** No clock of its own, no memory, no ledger —
 *   whether Riki has already said something is the novelty gate's question, and answering it here
 *   would put a ledger projection inside a function that runs on every version bump.
 * - **A detector that cannot answer honestly emits nothing.** Six of the eight can be starved of
 *   their input, and every one of them returns an empty array rather than a low-confidence guess.
 *   dota2 §4's rule 3 applies to detection as much as to rendering.
 *
 * And one that is this file's own: **confidence travels**. `confidenceOf` is the minimum over the
 * facts a detector actually read, which is the same rule `derivedFact` uses in
 * `packages/world-model` — a detection built on a 0.55 minimap blob is a 0.55 detection, and
 * salience multiplies by it (§4.3).
 */

import type { Fact, FieldPath, GameClock, HeroId, MonoMs, WorldSnapshot } from '@riki/world-model';
import { fieldPath, heroField } from '@riki/world-model';
import type { TriggerConfig } from '../config.js';

/** The only place a `FieldPath` is spelled in this package. */
export function path(...segments: readonly string[]): FieldPath {
  return fieldPath(...segments);
}

export const SELF_HEALTH = path('self', 'health');
export const SELF_MANA = path('self', 'mana');
export const SELF_ALIVE = path('self', 'alive');
export const SELF_POSITION = path('self', 'position');
export const SELF_ABILITIES = path('self', 'abilities');
export const SELF_ITEMS = path('self', 'items');
export const META_PHASE = path('meta', 'phase');
export const META_MODE = path('meta', 'mode');

/** `undefined` rather than a throw, everywhere. `WorldSnapshot.get` is already total. */
export function factAt<T>(world: WorldSnapshot, at: FieldPath): Fact<T> | undefined {
  return world.get<T>(at)?.fact;
}

/**
 * The minimum confidence over the facts a detection was built from.
 *
 * Absent facts are skipped rather than counted as zero: a detector that reached for something
 * optional and did not find it did not become less sure of what it did find. With nothing at all,
 * the answer is 0 — a detection with no facts behind it should score nothing.
 */
export function confidenceOf(...facts: readonly (Fact<unknown> | undefined | null)[]): number {
  let min: number | null = null;
  for (const fact of facts) {
    if (fact === null || fact === undefined) continue;
    min = min === null ? fact.confidence : Math.min(min, fact.confidence);
  }
  return min ?? 0;
}

/** The oldest game clock among some facts, so a tape entry is stamped when it was observed. */
export function clockOf(
  world: WorldSnapshot,
  ...facts: readonly (Fact<unknown> | undefined | null)[]
): GameClock | null {
  for (const fact of facts) {
    if (fact !== null && fact !== undefined && fact.atGameClock !== null) return fact.atGameClock;
  }
  return world.clock;
}

/** 0..1, and total: a missing or zero-max health fact yields `null`, never a division by zero. */
export function fractionOf(
  fact: Fact<{ readonly current: number; readonly max: number }> | undefined,
): number | null {
  if (fact === undefined || fact.value.max <= 0) return null;
  return Math.min(1, Math.max(0, fact.value.current / fact.value.max));
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Where a value sits between two configured bounds, as 0..1.
 *
 * Every magnitude in this directory is one of these or a `Math.max` of two, which is deliberate:
 * a blend would need weights, weights are behaviour, and behaviour belongs in `config.ts` (§4.5).
 */
export function ramp(value: number, from: number, to: number): number {
  if (to <= from) return value >= to ? 1 : 0;
  return clamp01((value - from) / (to - from));
}

/** The player is alive and the match is running. Every combat detector asks this first. */
export function selfAlive(world: WorldSnapshot): boolean {
  return factAt<boolean>(world, SELF_ALIVE)?.value === true;
}

/**
 * Enemies whose position is `fresh` and within `nearbyRadius`.
 *
 * "A fight might happen" is the precondition for two detectors and the whole of one term of the
 * intensity signal. `fresh` rather than merely present is the load-bearing word: a four-minute-old
 * minimap blob is not somebody standing next to you.
 */
export function nearbyEnemies(world: WorldSnapshot, cfg: TriggerConfig): readonly HeroId[] {
  const self = factAt<{ readonly x: number; readonly y: number }>(world, SELF_POSITION);
  if (self === undefined) return [];

  const near: HeroId[] = [];
  for (const view of world.enemies()) {
    if (view.staleness !== 'fresh') continue;
    const position = view.state.position;
    if (position === undefined) continue;
    const dx = position.value.x - self.value.x;
    const dy = position.value.y - self.value.y;
    if (Math.hypot(dx, dy) <= cfg.nearbyRadius) near.push(view.hero);
  }
  return near;
}

/** Any enemy seen recently enough to be worth reacting to, wherever they are. */
export function anyEnemyVisible(world: WorldSnapshot): boolean {
  return world.enemies().some((view) => view.staleness === 'fresh');
}

/** Known-dead, as distinct from never-observed. `undefined` means we have no idea. */
export function enemyAlive(world: WorldSnapshot, hero: HeroId): boolean | undefined {
  return factAt<boolean>(world, heroField('enemies', hero, 'alive'))?.value;
}

/** Monotonic milliseconds, for a `CoachEvent`'s stamp. The snapshot already carries it. */
export function nowOf(world: WorldSnapshot): MonoMs {
  return world.now;
}

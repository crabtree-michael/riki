/**
 * Two clocks, and the type system keeps them apart.
 *
 * Conflating them is the most likely bug in this subsystem. GSI's update rate is unreliable
 * (2–8 Hz, irregular), so anything derived from wall time and anything derived from match time
 * have to be distinguishable by the compiler rather than by a variable name.
 *
 * See docs/design/state-capture-architecture.md §3.1 and §5.5.
 *
 * ⚠ Transitional. These belong to @riki/protocol, which is REPO_SKELETON.md §10 step 2 and still
 * empty. `packages/context/src/tools/types.ts` and `apps/desktop/src/shared/overlay.ts` declare
 * their own copies for the same reason. When protocol lands, all three import from it instead.
 */

/** Local monotonic milliseconds. Never wall-clock: a fact's age must not move when NTP steps. */
export type MonoMs = number & { readonly __brand: 'MonoMs' };

/** Dota's `map.clock_time`, in seconds. Negative before the horn. Frozen while paused. */
export type GameClock = number & { readonly __brand: 'GameClock' };

/** Match-relative durations: respawn timers, rune windows, buyback cooldowns. */
export type Seconds = number & { readonly __brand: 'Seconds' };

/**
 * Injected everywhere. `packages/world-model` never calls `performance.now()` — time arrives as a
 * parameter, which is what makes the fusion reducer pure and every Tier 1 test deterministic.
 */
export interface Clock {
  now(): MonoMs;
}

/** Every subscription in this package returns its own disposer. */
export type Unsubscribe = () => void;

// -----------------------------------------------------------------------------------------------
// Branding
// -----------------------------------------------------------------------------------------------

/**
 * The brands above exist to stop a wall-clock number being used where a match clock belongs, so
 * the cast that removes the brand should be spelled the same way everywhere and be greppable.
 * These are that spelling. They are identity functions; the check is at the type level.
 */
export function asMonoMs(value: number): MonoMs {
  return value as MonoMs;
}

export function asGameClock(value: number): GameClock {
  return value as GameClock;
}

export function asSeconds(value: number): Seconds {
  return value as Seconds;
}

/** Milliseconds between two monotonic readings. Negative when `then` is in the future. */
export function elapsedMs(then: MonoMs, now: MonoMs): number {
  return now - then;
}

/** Match-clock seconds converted to milliseconds, so both clocks are compared in one unit. */
export function gameClockDeltaMs(then: GameClock, now: GameClock): number {
  return (now - then) * 1000;
}

/**
 * The three clock-only rules: rune spawns, stack timing, and the Roshan window.
 *
 * They share a file because they share the one thing that makes them work — they are functions of
 * `map.clock_time` and nothing else, so they are correct through a pause for free and need no
 * source at all beyond the clock. Everything else in `rules/` needs at least one observation.
 *
 * ⚠ **Every constant below is patch-versioned and none has been checked against the current
 * patch.** Rune cadence in particular has changed repeatedly. They are grouped here, named, and
 * exported so that verifying them is one file and one test rather than a hunt.
 */

import type { Fact } from '../../fact.js';
import { derivedFact } from '../../fact.js';
import type { FieldPath, WorldState } from '../../state.js';
import { fieldPath } from '../../state.js';
import type { GameClock } from '../../time.js';
import type { DerivedRule } from '../registry.js';
import { DERIVED_IDS } from '../registry.js';

/** Bounty runes: every 3 minutes from the horn, including 0:00. */
export const BOUNTY_RUNE_PERIOD_SECONDS = 180;
/** Power runes: every 2 minutes from 6:00. */
export const POWER_RUNE_FIRST_SECONDS = 360;
export const POWER_RUNE_PERIOD_SECONDS = 120;
/** Water runes: 2:00 and 4:00 only, then never again. */
export const WATER_RUNE_SECONDS: readonly number[] = [120, 240];
/** Ancient and neutral camps stack when pulled at :53 of a minute. */
export const STACK_SECOND = 53;
/** Roshan respawns 8–11 minutes after death; the window is the uncertainty, not a guess at it. */
export const ROSHAN_RESPAWN_MIN_SECONDS = 480;
export const ROSHAN_RESPAWN_MAX_SECONDS = 660;

export interface RuneTimings {
  /** Match-clock seconds of the next spawn, and how far away it is. Null once none remain. */
  readonly nextBountyAt: number;
  readonly nextBountyIn: number;
  readonly nextPowerAt: number;
  readonly nextPowerIn: number;
  readonly nextWaterAt: number | null;
  readonly nextWaterIn: number | null;
}

const CLOCK_PATH: FieldPath = fieldPath('meta', 'clock');
const ROSHAN_PATH: FieldPath = fieldPath('map', 'roshanState');

/** The clock as a number, or null before the horn — a negative clock is pre-game, not a timing. */
function liveClock(state: WorldState, clock: GameClock | null): number | null {
  const value = clock ?? state.meta.clock?.value ?? null;
  return value === null || value < 0 ? null : value;
}

export function createRuneTimingsRule(): DerivedRule<RuneTimings> {
  return {
    id: DERIVED_IDS.runeTimings,
    dependsOn: [CLOCK_PATH],
    compute(state, now, clock): Fact<RuneTimings> | null {
      const t = liveClock(state, clock);
      const source = state.meta.clock;
      if (t === null || source === undefined) return null;

      const nextBountyAt =
        Math.ceil((t + 1) / BOUNTY_RUNE_PERIOD_SECONDS) * BOUNTY_RUNE_PERIOD_SECONDS;
      const nextPowerAt =
        t < POWER_RUNE_FIRST_SECONDS
          ? POWER_RUNE_FIRST_SECONDS
          : POWER_RUNE_FIRST_SECONDS +
            Math.ceil((t - POWER_RUNE_FIRST_SECONDS + 1) / POWER_RUNE_PERIOD_SECONDS) *
              POWER_RUNE_PERIOD_SECONDS;
      const nextWaterAt = WATER_RUNE_SECONDS.find((at) => at > t) ?? null;

      return derivedFact<RuneTimings>(
        {
          nextBountyAt,
          nextBountyIn: nextBountyAt - t,
          nextPowerAt,
          nextPowerIn: nextPowerAt - t,
          nextWaterAt,
          nextWaterIn: nextWaterAt === null ? null : nextWaterAt - t,
        },
        { observedAt: now, atGameClock: clock },
        [source],
      );
    },
  };
}

export interface StackTiming {
  /** Match-clock second of the next :53, and the seconds until it. */
  readonly nextStackAt: number;
  readonly nextStackIn: number;
}

export function createStackTimingRule(): DerivedRule<StackTiming> {
  return {
    id: DERIVED_IDS.stackTiming,
    dependsOn: [CLOCK_PATH],
    compute(state, now, clock): Fact<StackTiming> | null {
      const t = liveClock(state, clock);
      const source = state.meta.clock;
      if (t === null || source === undefined) return null;

      const secondInMinute = t % 60;
      const untilNext =
        secondInMinute < STACK_SECOND
          ? STACK_SECOND - secondInMinute
          : 60 - secondInMinute + STACK_SECOND;

      return derivedFact<StackTiming>(
        { nextStackAt: t + untilNext, nextStackIn: untilNext },
        { observedAt: now, atGameClock: clock },
        [source],
      );
    },
  };
}

export interface RoshanWindow {
  /** Match-clock seconds. Roshan cannot be up before `opensAt` and must be up by `closesAt`. */
  readonly opensAt: number;
  readonly closesAt: number;
  readonly opensIn: number;
  /** True once the window has opened: Roshan may be up, and the only way to know is to look. */
  readonly maybeUp: boolean;
}

/**
 * Only answers while Roshan is *known* dead, and only if that observation carried a match clock.
 *
 * A window computed from a death whose time we do not know would be a number with nothing behind
 * it, and this is precisely the fact a coach must not invent: dota2 §8.2 allows only what the
 * player could have seen, and "Rosh is probably up" from a guessed death time is not that.
 */
export function createRoshanWindowRule(): DerivedRule<RoshanWindow> {
  return {
    id: DERIVED_IDS.roshanWindow,
    dependsOn: [ROSHAN_PATH],
    compute(state, now, clock): Fact<RoshanWindow> | null {
      const roshan = state.map.roshanState;
      const t = liveClock(state, clock);
      if (roshan?.value !== 'dead' || roshan.atGameClock === null) return null;
      if (t === null) return null;

      const opensAt = roshan.atGameClock + ROSHAN_RESPAWN_MIN_SECONDS;
      const closesAt = roshan.atGameClock + ROSHAN_RESPAWN_MAX_SECONDS;

      return derivedFact<RoshanWindow>(
        { opensAt, closesAt, opensIn: opensAt - t, maybeUp: t >= opensAt },
        { observedAt: now, atGameClock: clock },
        [roshan],
      );
    },
  };
}

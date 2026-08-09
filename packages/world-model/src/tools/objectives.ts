/**
 * `objectives()` — the map: buildings, Roshan, runes, day or night, and the clock they are all
 * relative to.
 *
 * Three of the five fields are clock arithmetic that `derived/rules/timings.ts` already owns, and
 * this calls those rules rather than repeating them. That is not only reuse: the rune and Roshan
 * rules are functions of `map.clock_time` alone, which is what makes them correct through a pause
 * for free, and a second implementation here would be the one that got pauses wrong.
 */

import type { RoshanReport, RuneReport, ToolResultFor } from '@riki/protocol';
import type { ToolContext } from './context.js';
import {
  UNKNOWN_REASONS,
  atLeastZero,
  formatGameClock,
  envelope,
  envelopeOf,
  noMatchInProgress,
} from './context.js';
import { buildingsFact } from './buildings.js';
import { createRoshanWindowRule, createRuneTimingsRule } from '../derived/rules/timings.js';

const NOT_SEEN = UNKNOWN_REASONS.neverObserved;

export function objectives(ctx: ToolContext): ToolResultFor<'objectives'> {
  const noMatch = noMatchInProgress(ctx);
  if (noMatch !== null) return noMatch;

  const { state, now } = ctx;

  return {
    // Every other timing in this report is relative to it, so it travels with them rather than
    // being assumed. Enveloped from `meta.clock` and not from `ctx.clock`: the age matters, because
    // a clock read forty seconds ago makes every rune timing below it forty seconds wrong.
    clock: envelopeOf(state.meta.clock, now, UNKNOWN_REASONS.noClockYet, formatGameClock),
    daytime: envelope(state.map.daytime, now, NOT_SEEN),
    buildings: envelope(
      buildingsFact(state, now, ctx.clock) ?? undefined,
      now,
      'the buildings, or which side you are on, were never observed',
    ),
    roshan: roshan(ctx),
    runes: runes(ctx),
  };
}

/**
 * Roshan's three world-model states collapse into two, plus the envelope.
 *
 * `RoshanState` is `alive | dead | unknown`, and the third one is not a state Roshan is in — it is
 * an absence of observation, which is what the envelope is for. So `unknown` becomes the
 * `UnknownFact` branch and the report itself only ever says `alive` or `dead`. A `RoshanReport`
 * carrying `state: 'unknown'` would be a thing the model could read past.
 */
function roshan(ctx: ToolContext) {
  const state = ctx.state.map.roshanState;
  if (state === undefined || state.value === 'unknown') {
    return { unknown: 'nobody has seen Roshan this match' };
  }

  const window = createRoshanWindowRule().compute(ctx.state, ctx.now, ctx.clock);
  const t = ctx.clock ?? ctx.state.meta.clock?.value ?? null;

  return envelopeOf<'alive' | 'dead' | 'unknown', RoshanReport>(
    state,
    ctx.now,
    NOT_SEEN,
    (value) => ({
      state: value === 'dead' ? 'dead' : 'alive',
      // Null while he is alive, and null while he is dead at a time nobody recorded — the rule
      // refuses to compute a window from a death whose clock it does not have, because a window is
      // the uncertainty and not a guess at the middle of it. Both nulls are the schema's, and the
      // model reads them as "no window", never as "the window is now".
      respawn_window:
        window === null || t === null
          ? null
          : {
              opens_in_seconds: window.value.opensAt - t,
              closes_in_seconds: window.value.closesAt - t,
              maybe_up: window.value.maybeUp,
            },
    }),
  );
}

/** Clock-only, so this is unknown exactly when the match has no clock — never for want of a source. */
function runes(ctx: ToolContext) {
  const fact = createRuneTimingsRule().compute(ctx.state, ctx.now, ctx.clock);
  return envelopeOf<
    { nextBountyIn: number; nextPowerIn: number; nextWaterIn: number | null },
    RuneReport
  >(fact ?? undefined, ctx.now, UNKNOWN_REASONS.noClockYet, (t) => ({
    next_bounty_in_seconds: atLeastZero(t.nextBountyIn),
    next_power_in_seconds: atLeastZero(t.nextPowerIn),
    // Water runes are 2:00 and 4:00 only, so this is null for most of a match — "no more water
    // runes", not "a water rune in zero seconds".
    next_water_in_seconds: t.nextWaterIn === null ? null : atLeastZero(t.nextWaterIn),
  }));
}

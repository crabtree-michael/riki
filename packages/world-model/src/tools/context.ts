/**
 * What every tool is given, and the two functions that keep the `Fact` envelope intact on the way
 * out.
 *
 * The tools in this directory are the read side of ADR-0042: with no trigger engine choosing the
 * topic of a turn, the model reaches the world through five named tools instead of through a brief
 * someone else assembled. `packages/protocol` owns the shapes (`schemas/tools.ts`); this owns the
 * projection from `WorldState` onto them, and its whole correctness obligation is ADR-0043's — a
 * value crosses with its age, confidence and source, or it does not cross at all.
 *
 * ## Why the input is not a `WorldSnapshot`
 *
 * `ToolContext` is a structural subset of `WorldSnapshot`, so the live caller passes a snapshot and
 * nothing converts anything. But it is declared separately because T6's `world_at` reconstructs a
 * `WorldState` by replaying a recording and has no snapshot to offer — no staleness policy and no
 * derived registry are involved in reading back a past instant. Demanding a snapshot would make
 * `world_at` fabricate two collaborators it does not use in order to call the same four functions.
 *
 * The three fields are exactly what a projection needs: the state, the wall clock that turns
 * `observedAt` into an age, and the match clock that the timing rules count from.
 *
 * ## Why the derived rules are called rather than looked up
 *
 * Three fields here — buyback affordability, the Roshan window, the net-worth lead — are already
 * `derived/rules/`, and those rules are the reason the arithmetic is trustworthy: each inherits the
 * *minimum* confidence and the *oldest* `observedAt` of its inputs (`derivedFact`), which is what
 * makes "you can buy back" carry the age of the gold reading it was computed from.
 *
 * The tools call `rule.compute(...)` directly instead of reading `snapshot.derived`. `DerivedView`
 * only answers for rules the composition root happened to register, so a tool that read through it
 * would return `unknown` — indistinguishable from "nobody observed it" — on a perfectly observed
 * world whose app forgot a `register` call. A tool's answer must not depend on the app's wiring.
 * The cost is one recomputation per call, and tool calls happen once or twice a turn.
 */

import type { KnownFact, ToolFact } from '@riki/protocol';
import { UNKNOWN_REASONS } from '@riki/protocol';
import type { Fact } from '../fact.js';
import type { WorldState } from '../state.js';
import type { GameClock, MonoMs } from '../time.js';

/**
 * The world, and the two clocks needed to read it.
 *
 * Structurally satisfied by `WorldSnapshot`, deliberately — see the header.
 */
export interface ToolContext {
  readonly state: WorldState;
  /** Turns each fact's `observedAt` into the `age_seconds` the model is shown. */
  readonly now: MonoMs;
  /** The match clock the timing rules count from. Null before the horn, and during draft. */
  readonly clock: GameClock | null;
}

export { UNKNOWN_REASONS };

// -----------------------------------------------------------------------------------------------
// The envelope
// -----------------------------------------------------------------------------------------------

/**
 * Age in seconds, clamped at zero.
 *
 * The clamp is what `FactEnvelope.age_seconds` asks for in so many words — "a clock that ran
 * backwards is a bug to clamp at the producer, not a negative age to explain to a player" — and
 * this is the producer. The alternative is a `-0.2` that fails validation inside a turn the model
 * is already speaking, which is the one failure mode a voice product cannot absorb.
 */
function ageSeconds(fact: Fact<unknown>, now: MonoMs): number {
  return Math.max(0, (now - fact.observedAt) / 1000);
}

/**
 * A fact, enveloped — or the reason there is no fact.
 *
 * `absent` is prose because it is read aloud (`UnknownFact`). Reach for `UNKNOWN_REASONS` first so
 * that four tools written in one sitting do not give the player four vocabularies for "nobody
 * looked".
 */
export function envelope<T>(fact: Fact<T> | undefined, now: MonoMs, absent: string): ToolFact<T> {
  return fact === undefined ? { unknown: absent } : { ...enveloped(fact, now), value: fact.value };
}

/**
 * The same, for a value whose shape the model reads differently from the way the world model
 * stores it — `ItemState[]` to `ItemReport[]`, a `RoshanWindow` to a `RoshanReport`.
 *
 * Separate from `envelope` rather than an optional fourth argument so that neither call site has to
 * name a type parameter, and so that the identity case cannot silently pick up a mapper.
 */
export function envelopeOf<T, U>(
  fact: Fact<T> | undefined,
  now: MonoMs,
  absent: string,
  map: (value: T) => U,
): ToolFact<U> {
  return fact === undefined
    ? { unknown: absent }
    : { ...enveloped(fact, now), value: map(fact.value) };
}

function enveloped(fact: Fact<unknown>, now: MonoMs): Omit<KnownFact<never>, 'value'> {
  return { age_seconds: ageSeconds(fact, now), confidence: fact.confidence, source: fact.source };
}

// -----------------------------------------------------------------------------------------------
// Coercions
// -----------------------------------------------------------------------------------------------

/**
 * The two coercions the result schemas require, in one place so the reasoning is stated once.
 *
 * Several fields are `z.int()` or `.min(0)`: levels, last hits, cooldowns, respawn timers. Those
 * bounds are real — they are what the model is shown — and a value that violates one is rejected
 * at the boundary, mid-sentence. GSI's numbers satisfy them in practice; a `-0.03` cooldown from a
 * source that rounded badly, or a float where an integer belongs, should not take the turn down
 * with it.
 *
 * Note what these deliberately do *not* do: neither invents a value where there was none. That is
 * `unknown`'s job, and rounding a number is a different act from supplying one.
 */
export const atLeastZero = (value: number): number => (value > 0 ? value : 0);
export const whole = (value: number): number => Math.round(value);

// -----------------------------------------------------------------------------------------------
// The clock, as a person says it
// -----------------------------------------------------------------------------------------------

/**
 * Match-clock seconds to `12:34`, `1:05:00`, or `-1:30` before the horn.
 *
 * `GameClock` in `packages/protocol` is a string and here it is a branded number, which is why a
 * conversion is needed at all: the model both reads this and says it, and seconds would be the one
 * number in the answer with no unit attached. The negative branch is not cosmetic — pre-horn time
 * is not `0:00`, and the sign is in the protocol's grammar for that reason.
 *
 * **It lives in `packages/protocol` and not here**, beside the pattern it has to satisfy, because
 * T6 needs the inverse as well: `world_at` is *given* a clock string by the model and has to turn
 * it back into seconds to seek on. A formatter here and a parser there would be two readings of one
 * grammar, and they would disagree about `1:05:00` long before anyone noticed. `formatGameClock`
 * and `parseGameClock` are a tested pair (ADR-0048).
 *
 * `packages/context/src/snapshot/sections/util.ts` formats a clock too, and does not grow an hour
 * field. That one is still not shared: it renders a snapshot line under a token budget, this one
 * has to satisfy a regex the model is shown, and a package that may not import the other is the
 * wrong place to discover they disagree.
 */
export { formatGameClock } from '@riki/protocol';

// -----------------------------------------------------------------------------------------------
// The one guard every tool shares
// -----------------------------------------------------------------------------------------------

/**
 * `{ unknown: 'no match is in progress' }` when there is no match, and null when there is one.
 *
 * Every tool checks this first, and the reason is what the answer reads like without it: eleven
 * fields of `{ unknown: 'never observed this match' }` is a technically accurate description of
 * sitting in the Dota main menu, and a model handed it will narrate the absence — "I can't see your
 * health or your mana" — instead of saying the one true sentence.
 *
 * Only `idle` counts. Draft, strategy, hero selection and pre-game are all matches in progress that
 * happen to know very little yet, and there the field-by-field `unknown` is exactly right: "you
 * haven't picked yet" is a fact about the draft, not an absence of a game.
 */
export const NO_MATCH = 'no match is in progress';

export function noMatchInProgress(ctx: ToolContext): { readonly unknown: string } | null {
  return ctx.state.meta.phase.value === 'idle' ? { unknown: NO_MATCH } : null;
}

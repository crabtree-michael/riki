/**
 * `enemy(hero?)` — what is known about the other side, which is mostly inference and says so.
 *
 * ## The open question this ticket owns: `enemy()` with no argument returns all five
 *
 * Design §11 question 1 asked whether a no-argument call should return five summaries or refuse and
 * ask which hero. It returns every enemy observed so far. ADR-0046 records the decision; the short
 * form is four reasons, in the order they mattered:
 *
 * 1. **A refusal is the failure §4 built the tool surface to avoid.** Narrow tools exist because
 *    "a failed call is not a retry, it is a pause in a spoken sentence". A tool that could have
 *    answered and instead asks a clarifying question manufactures exactly that pause, and it
 *    manufactures it in the middle of a turn the model is already speaking.
 * 2. **The question players actually ask is the five-hero one.** "Where are they?", "is it safe to
 *    push?", "can I go rosh?" — none of those name a hero. Refusing the natural phrasing puts the
 *    common case on the slow path and the rare case on the fast one.
 * 3. **The cost is bounded, and it was measured rather than assumed.** Serialised against the T2
 *    fixtures: one fully-observed hero is 612 bytes, so five at that density are **3.0 kB**; five
 *    heroes in the roster with nothing else known are **1.7 kB** (the reason strings repeat, which
 *    is what honesty costs); and an empty roster is the 37-byte outer `unknown`. So the expensive
 *    case is the one where the tool has genuinely learned five heroes' worth of things — which is
 *    the case where the model needed them — and the early match, where a refusal would have saved
 *    the most, is already the cheapest answer the tool gives.
 * 4. **A refusal is indistinguishable from a broken tool.** `EnemyResult`'s unknown branch means
 *    "there is nothing to answer with". Spending it on "I could have answered but chose not to"
 *    teaches the model that unknowns are worth retrying, which is precisely the habit that makes it
 *    state a guess when a genuine unknown comes back.
 *
 * What is *not* done, despite design §4's wording ("omit the argument for all five, **summarised**"):
 * the per-hero shape does not shrink for a no-argument call. T2 gave both calls one `EnemyReport`,
 * and a field that is present when you name a hero and absent when you do not is a field whose
 * `unknown` has two meanings — "nobody looked" and "you didn't ask properly". That ambiguity is the
 * flattening ADR-0043 exists to prevent, and it would be invisible.
 */

import type { EnemyReport, ToolResultFor } from '@riki/protocol';
import type { EnemyState, HeroId, WorldState } from '../state.js';
import type { ToolContext } from './context.js';
import {
  UNKNOWN_REASONS,
  atLeastZero,
  envelope,
  envelopeOf,
  noMatchInProgress,
} from './context.js';

export interface EnemyQuery {
  /** Valve's short name, e.g. `shadow_fiend`. Omit for every enemy observed so far. */
  readonly hero?: string | undefined;
}

const NOT_SEEN = UNKNOWN_REASONS.neverObserved;

export function enemy(ctx: ToolContext, query: EnemyQuery = {}): ToolResultFor<'enemy'> {
  const noMatch = noMatchInProgress(ctx);
  if (noMatch !== null) return noMatch;

  const roster = observedRoster(ctx.state);

  if (query.hero === undefined) {
    if (roster.length === 0) return { unknown: 'no enemy hero has been observed this match yet' };
    return { enemies: roster.map(([hero, state]) => report(hero, state, ctx)) };
  }

  const wanted = heroKey(query.hero);
  const found = roster.find(([hero]) => heroKey(hero) === wanted);
  if (found === undefined) return { unknown: notObserved(query.hero, roster) };
  return { enemies: [report(found[0], found[1], ctx)] };
}

/**
 * Alphabetical by hero name, and not by recency.
 *
 * Most-recently-seen-first is the more useful order and is the wrong one here: two calls in one
 * turn would return the same five heroes in two different orders, which reads to the model as the
 * world having moved when only the sort key did. Every entry carries its own age in the envelope,
 * so the model can order them itself and can see that it is doing so.
 */
function observedRoster(state: WorldState): readonly (readonly [HeroId, EnemyState])[] {
  return [...state.enemies.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Says what is not known, and what is — the distinction that stops a confident falsehood.
 *
 * An enemy enters `state.enemies` by being *observed*, so a name that is absent from it has two
 * completely different explanations: the hero is not in this game, or nothing has read the draft
 * yet. "There is no hero called Puck in this match" is one short sentence away from being a lie,
 * and the model would say it in a tone of complete certainty. Naming the roster we do have lets the
 * model correct itself without another call, and costs a dozen tokens.
 */
function notObserved(asked: string, roster: readonly (readonly [HeroId, EnemyState])[]): string {
  if (roster.length === 0)
    return `nothing has been observed about "${asked}", or about any enemy hero, this match`;
  return `nothing has been observed about "${asked}" this match; the enemies seen so far are ${roster
    .map(([hero]) => String(hero))
    .join(', ')}`;
}

/**
 * Normalises only what is unambiguously the same name: case, surrounding space, the
 * `npc_dota_hero_` prefix GSI uses, and spaces or hyphens where the world model keys on
 * underscores. So `"Shadow Fiend"`, `shadow-fiend` and `npc_dota_hero_shadow_fiend` all find
 * `shadow_fiend`.
 *
 * It deliberately stops short of aliases — `nevermore`, `wr`, `magina`. Those are hero reference
 * data, they live in `packages/context`'s hero library, and `packages/world-model` may not import
 * it (ADR-0014, and the lint rule that enforces it). A half-copied alias table here would be a
 * second source of truth for hero identity that drifts silently. Until the resolver moves somewhere
 * both packages can see, an alias misses and the model is told the observed roster instead, which
 * is a recoverable answer rather than a wrong one.
 */
function heroKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^npc_dota_hero_/, '')
    .replace(/[\s-]+/g, '_');
}

function report(hero: HeroId, state: EnemyState, ctx: ToolContext): EnemyReport {
  const now = ctx.now;
  return {
    // The one unenveloped value in the whole tool surface: it is the address of the answer rather
    // than an observation about the world (`EnemyReport` in packages/protocol).
    hero: String(hero),
    level: envelope(state.level, now, NOT_SEEN),
    alive: envelope(state.alive, now, NOT_SEEN),
    respawn_in_seconds: envelopeOf(state.respawnIn, now, NOT_SEEN, atLeastZero),
    // `lastSeenAt` and not `position`. They are written by the same CV step from the same
    // observation, and `lastSeenAt` is given a far longer expiry — so it is the field that survives
    // to answer "where were they last", which is the question this tool is for. Which of the two
    // claims it is — "is bottom" or "was bottom thirty seconds ago" — is the envelope's `age_seconds`,
    // and that is the whole reason the envelope travels.
    last_seen: envelopeOf(state.lastSeenAt, now, NOT_SEEN, (at) => ({
      x: at.x,
      y: at.y,
      // Null, always, and not for want of trying: naming a map point needs a region table —
      // position to "bottom rune", "their jungle" — which does not exist in this repo. The world
      // view adapter records the same gap (`apps/desktop/src/main/agent/world-view.ts`, the
      // PROJECTIONS comment) and puts the table with the sidecar, which already speaks in regions.
      // The coordinates are honest and unspeakable; a name invented here would be speakable and
      // wrong.
      area: null,
    })),
    net_worth: envelopeOf(state.netWorth, now, NOT_SEEN, atLeastZero),
    items_seen: itemsSeen(state, ctx),
  };
}

/**
 * One fact per item, and `unknown` for the empty case rather than `[]`.
 *
 * The schema asks for `unknown` "when nothing has ever looked", which is not the same as the empty
 * list — and the world model cannot tell those two apart: `itemsSeen` starts empty and there is no
 * flag recording whether a detector ever ran. Given the ambiguity this takes the conservative
 * branch, because the two mistakes are not the same size. `[]` licenses "they haven't got anything"
 * — at minute thirty, about a hero holding a BKB, in a player's ear. `unknown` costs a sentence
 * nobody minds.
 */
function itemsSeen(state: EnemyState, ctx: ToolContext): EnemyReport['items_seen'] {
  if (state.itemsSeen.size === 0) return { unknown: 'no item has been seen on this hero' };
  return [...state.itemsSeen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([item, fact]) => envelopeOf(fact, ctx.now, NOT_SEEN, () => String(item)));
}

/**
 * `world_at` — the fifth tool, and the only one that reads something other than the live model.
 *
 * It is deliberately thin. Reconstructing the instant is `reader.ts`'s job and describing a world
 * is T3's; this is the join, and the join is where the design's actual requirement lives —
 * *"return the same shapes as T3's tools"* (`conversational-migration-tickets.md` T6).
 *
 * ## It calls the same four functions the live tools are
 *
 * The obvious implementation renders `MyStateReport` and the other three from a reconstructed
 * `WorldState` right here. It would be wrong within a week: there would be two renderers for one
 * shape, `my_state()` and `world_at(topic: 'my_state')` would answer the same question
 * differently, and nothing would fail — both would parse, both would sound right, and only one
 * would be current. The design's whole correctness story is that a historical answer is the same
 * kind of thing as a live one, so it has to be produced by the same code.
 *
 * So `DEFAULT_WORLD_AT_PROJECTIONS` is literally `tools/`'s `myState`, `enemy`, `objectives` and
 * `economy`, and `Reconstruction.snapshot` satisfies their `ToolContext` structurally. They stay a
 * *parameter* rather than a direct call because that is what a test can substitute: the assertions
 * this file needs are about the join — which sections were asked for, what an absent one does, what
 * moment the projections were handed — and making each of those depend on four real renderers would
 * be testing T3 again, badly.
 *
 * ## What a historical answer must not do
 *
 * Ages are computed at the reconstructed instant, never at the wall clock the question was asked
 * at. "Where was he at twelve minutes" must answer "last seen four seconds before that", not
 * "last seen eighteen minutes ago" — the second is true of the recording and useless about the
 * match. `reader.ts` supplies the snapshot already stamped with the right `now`; this file must
 * not hand a different one down.
 */

import type { ToolArgumentsFor, ToolResultFor, UnknownFact, WorldAtReport } from '@riki/protocol';
import { UNKNOWN_REASONS, formatGameClock, isUnknown, parseGameClock } from '@riki/protocol';

import type { ToolContext } from '../tools/context.js';
import { economy, enemy, myState, objectives } from '../tools/index.js';
import { asGameClock } from '../time.js';
import type { Timeline, TimelineTarget } from './reader.js';

/**
 * The four tools T3 owns, as `world_at` needs them: a past instant in, a report or a reason out.
 *
 * `ToolContext` and not `WorldSnapshot`, which is the signature `tools/context.ts` chose for this
 * caller by name — a reconstruction has no staleness policy or derived registry to offer, and
 * demanding a snapshot would make `world_at` fabricate two collaborators it does not use.
 * `Reconstruction.snapshot` satisfies it anyway.
 *
 * `enemy` takes no hero here. `world_at`'s `topic` names a section rather than a subject, and a
 * past moment is exactly when the model wants all of them — narrowing to one hero is what the live
 * `enemy(hero)` is for.
 */
export interface WorldAtProjections {
  readonly my_state: (ctx: ToolContext) => ToolResultFor<'my_state'>;
  readonly enemy: (ctx: ToolContext) => ToolResultFor<'enemy'>;
  readonly objectives: (ctx: ToolContext) => ToolResultFor<'objectives'>;
  readonly economy: (ctx: ToolContext) => ToolResultFor<'economy'>;
}

/** The live four, unchanged. Anything else answering a `world_at` call is a second renderer. */
export const DEFAULT_WORLD_AT_PROJECTIONS: WorldAtProjections = {
  my_state: myState,
  enemy,
  objectives,
  economy,
};

export interface WorldAtDeps {
  /**
   * Opened over the recording as it stands *now*. `secondsAgo` is measured from the last line the
   * timeline holds, so a live caller reopens per call rather than keeping one — see
   * `TimelineTarget`.
   */
  readonly timeline: Timeline;
  /** Defaults to the live tools. A test substitutes; the composition root should not. */
  readonly projections?: WorldAtProjections;
}

/** The topics `WorldAtArguments` allows, and the report key each one fills. */
const SECTIONS = {
  my_state: 'my_state',
  enemy: 'enemies',
  objectives: 'objectives',
  economy: 'economy',
} as const satisfies Record<keyof WorldAtProjections, keyof WorldAtReport>;

type Topic = keyof typeof SECTIONS;

const ALL_TOPICS = Object.keys(SECTIONS) as readonly Topic[];

/**
 * One `world_at` call, answered.
 *
 * Never throws and never rejects: every failure it can have — a moment before the recording, a
 * match with no clock yet, nothing observed at that instant — is an `UnknownFact` with a sentence
 * in it, because this runs inside a turn that is already speaking and an exception here is a
 * sentence that stops in the middle.
 */
export function answerWorldAt(
  deps: WorldAtDeps,
  args: ToolArgumentsFor<'world_at'>,
): ToolResultFor<'world_at'> {
  const target = targetOf(args);
  if (target === null) {
    // `parseToolCall` refuses this shape before it gets here, so reaching it means the arguments
    // came from somewhere that did not validate them. Answering rather than throwing keeps that a
    // recoverable turn.
    return { unknown: 'ask for a moment as a match clock or as seconds ago, and only one of them' };
  }

  const found = deps.timeline.at(target);
  if (isUnknown(found)) return found;

  // A moment before the horn is a real moment with no clock, and `at_clock` has nowhere to put
  // that. The draft is answerable in principle; saying so is T-something-later's problem, and
  // inventing "0:00" for it here would be a lie with a plausible face.
  if (found.at.clock === null) return { unknown: UNKNOWN_REASONS.noClockYet };
  const at_clock = formatGameClock(found.at.clock);

  const topics: readonly Topic[] = args.topic === undefined ? ALL_TOPICS : [args.topic];
  const projections = deps.projections ?? DEFAULT_WORLD_AT_PROJECTIONS;
  const sections: Partial<Omit<WorldAtReport, 'at_clock'>> = {};
  const reasons: UnknownFact[] = [];

  for (const topic of topics) {
    const answer = projections[topic](found.snapshot);
    if (isUnknown(answer)) {
      reasons.push(answer);
      continue;
    }
    // A section that answered goes in; one that did not is *absent*, not present and empty.
    // `WorldAtReport` has no unknown branch per section, so an absence is how a section says
    // nothing — and the refinement below is what stops all four of them saying it at once.
    Object.assign(sections, { [SECTIONS[topic]]: answer });
  }

  if (Object.keys(sections).length === 0) {
    // `WorldAtReport` refuses an answer with no sections, and rightly: a bare `at_clock` is
    // silence the model would narrate as though it had been told something. One topic asked
    // carries its own reason back verbatim — "never observed this match" is the sentence to say.
    return reasons.length === 1 && reasons[0] !== undefined
      ? reasons[0]
      : { unknown: `nothing was observed at ${at_clock}` };
  }

  return { at_clock, ...sections };
}

/**
 * The arguments, on the axis each one belongs to.
 *
 * A clock is match time and `seconds_ago` is wall time, and the conversion between them is a
 * conversion this function deliberately does not do: during a pause they differ, and picking one
 * would make "thirty seconds ago" mean something other than thirty seconds for the one stretch of
 * a match where somebody is most likely to be asking. ADR-0048.
 */
function targetOf(args: ToolArgumentsFor<'world_at'>): TimelineTarget | null {
  if (args.clock !== undefined && args.seconds_ago !== undefined) return null;
  if (args.clock !== undefined) {
    // @riki/protocol owns the grammar as well as the pattern, so this is a lookup rather than a
    // second reading of "how a match clock is spelled".
    const seconds = parseGameClock(args.clock);
    return seconds === null ? null : { clock: asGameClock(seconds) };
  }
  if (args.seconds_ago !== undefined) return { secondsAgo: args.seconds_ago };
  return null;
}

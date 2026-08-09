/**
 * The `ToolDispatcher` — the thing the model's five tools actually reach (ADR-0042, T12).
 *
 * `packages/world-model` owns the four live projections and `timeline/` owns `world_at`, and
 * deliberately **nothing there dispatches**: turning a name that arrived from a language model
 * into one of those calls would put the seam on the wrong side of §6.2's boundary, and the world
 * model may not know it is feeding an LLM. `packages/realtime` declares the port and does not
 * implement it either, because it may not know what a `WorldState` is. So the table lives here, in
 * the one process that is allowed to hold both facts at once.
 *
 * ## Everything in this file exists inside a sentence that is already being spoken
 *
 * A tool call happens mid-response (ADR-0049), so the cost of every decision is measured in what
 * the player hears next. Two consequences shape the whole file:
 *
 * - **Nothing throws that can be answered instead.** A tool that has no answer returns
 *   `{ unknown: … }` (ADR-0043), which is a *valid* result for all five tools rather than an error
 *   channel, and the model reads it as a sentence. A genuine bug still throws — `main/voice/`
 *   catches it and degrades — but a missing recording, a match that has not started and a moment
 *   before the horn are ordinary answers and are answered.
 * - **A tool's answer must not depend on the app's wiring.** `tools/context.ts` states this for
 *   the derived rules and it applies to this file too: `world_at` reading nothing because the
 *   composition root forgot a directory would be indistinguishable, to the model, from a match
 *   nobody recorded. So the reason is always in the `unknown`.
 *
 * ## `world_at` reopens the recording on every call, and that is not an oversight
 *
 * `TimelineTarget`'s `secondsAgo` is measured from the **last line the timeline holds**, so a
 * timeline opened at `match_started` and kept would answer "thirty seconds ago" about the match's
 * first thirty seconds, forever, while sounding entirely current. `reader.ts` says so in as many
 * words. The cost is re-reading the match file per call; the calls are once or twice a turn, the
 * read is asynchronous, and the alternative is an answer that is wrong in a way nobody can hear.
 */

import type { ToolArgumentsFor, ToolName, ToolResultFor } from '@riki/protocol';
import type { ToolDispatcher } from '@riki/realtime';
import type { Clock as WorldClock, StalenessPolicy, WorldSnapshot } from '@riki/world-model';
import {
  answerWorldAt,
  economy,
  enemy,
  myState,
  objectives,
  openTimeline,
} from '@riki/world-model';

export interface WorldToolDeps {
  /** The live model. `WorldSnapshot` satisfies `ToolContext` structurally — `tools/context.ts`. */
  readonly world: { snapshot(now: number): WorldSnapshot };
  readonly clock: WorldClock;
  /**
   * The match recording as it stands *now*, or null when there is nothing to read.
   *
   * A function returning text rather than a path, for two reasons. It keeps `node:fs` out of the
   * dispatcher, so `tools.test.ts` answers a `world_at` from a string; and it puts "which match is
   * open" in the composition root, which is the only place that knows — the recorder's `matchId`
   * changes under this object between games.
   *
   * Absent means `world_at` answers that there is no recording. That is a real configuration: a
   * `buildStateSubsystem` with no `recording` option records nothing.
   */
  readonly recording?: () => Promise<string | null>;
  /**
   * The policy the live store fuses with.
   *
   * `TimelineOptions` asks for the same set the store was built with, and it is not a detail: a
   * replay under different staleness reconstructs a match that never happened, and the failure
   * looks like a subtle disagreement rather than an error.
   */
  readonly staleness?: StalenessPolicy;
}

/** Why `world_at` has nothing to read. Prose, because the model says it out loud (ADR-0043). */
const NO_RECORDING = 'no match is being recorded, so there is no past to look at';

export function createWorldToolDispatcher(deps: WorldToolDeps): ToolDispatcher {
  async function answer<N extends ToolName>(
    name: N,
    args: ToolArgumentsFor<N>,
  ): Promise<ToolResultFor<ToolName>> {
    if (name === 'world_at') {
      const contents = await (deps.recording?.() ?? Promise.resolve(null));
      if (contents === null || contents === '') return { unknown: NO_RECORDING };
      const timeline = openTimeline(contents, {
        ...(deps.staleness === undefined ? {} : { staleness: deps.staleness }),
      });
      return answerWorldAt({ timeline }, args as ToolArgumentsFor<'world_at'>);
    }

    // One read for the whole call, and the same one every tool in it sees. Taking a fresh snapshot
    // per projection would let two halves of one answer describe two different instants — which is
    // the kind of inconsistency that is invisible in a log and audible in a sentence.
    const ctx = deps.world.snapshot(deps.clock.now());

    switch (name) {
      case 'my_state':
        return myState(ctx);
      case 'enemy':
        return enemy(ctx, args as ToolArgumentsFor<'enemy'>);
      case 'objectives':
        return objectives(ctx);
      case 'economy':
        return economy(ctx);
      default:
        // `ToolName` is a closed set and every member is above, so this is a build that got out of
        // step with `schemas/tools.ts`. Answered rather than thrown, because it would be answered
        // one layer up anyway and the reason is more useful than the stack.
        return { unknown: `\`${name}\` is not a tool this build knows how to answer` };
    }
  }

  return {
    async call<N extends ToolName>(name: N, args: ToolArgumentsFor<N>): Promise<ToolResultFor<N>> {
      // The one cast here, and it is the same one `callTool` holds in `packages/realtime` for the
      // same reason: `name` and the value returned for it came from the same member of `TOOLS`,
      // and TypeScript cannot see that through the switch. It is checked rather than trusted —
      // `encodeToolOutput` parses the result against `TOOLS[name].result` before the model sees
      // it, so a mismatched pair comes back as an `unknown` instead of as a confident wrong answer.
      return (await answer(name, args)) as ToolResultFor<N>;
    },
  };
}

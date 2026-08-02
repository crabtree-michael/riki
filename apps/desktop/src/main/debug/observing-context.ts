/**
 * What the coach was actually given, and what became of it.
 *
 * `ContextAssembler.openTurn` renders the snapshot and the coaching brief, appends both to the
 * ledger, and returns them to the agent — which composes them into one system message and forgets
 * them. The ledger keeps the text, but nothing projects it anywhere a person can read, and
 * `fixtures/golden/` only shows what the renderers produce for a *fixture*. So the one rendering
 * that matters — the one Riki was about to say something on the strength of — has been the least
 * inspectable thing in the process.
 *
 * This decorator observes `openTurn` and `closeTurn` and reports what they produced. Like
 * `observing-policy.ts` it returns the delegate's value unchanged and decides nothing.
 *
 * ## Why a decorator rather than a hook on the agent
 *
 * `createCoachingAgent` would need a new optional dep, a call on the empty-brief path and a call on
 * the normal path, and the two would have to stay in step with `endPlayerTurn`'s third one. The
 * shell already constructs the `RikiContext` and injects it into both the engine and the agent, so
 * wrapping it here covers every caller — including the player-turn path and any future one — with
 * no change to the code that has to stay correct when the inspector is off.
 */

import type { RikiContext, TurnContext, TurnOutcome, TurnId } from '@riki/context';
import type { MonoMs } from '@riki/world-model';

import type { DebugTurnOpenedInput } from './contracts.js';

export interface ObservingContextDeps {
  readonly delegate: RikiContext;
  readonly onOpened: (turn: DebugTurnOpenedInput) => void;
  readonly onClosed: (turnId: string, outcome: string) => void;
  /** The match clock, for the turn's row. Read from the world model, not from the turn. */
  readonly clock: () => number | null;
}

/**
 * ⚠ **Spread-and-override, and it relies on `createContextAssembler` returning a plain record.**
 *
 * It does — every member of its return is an own enumerable property or a method, with no getters
 * and no prototype — and `observing-context.test.ts` asserts that every key of a real assembler
 * survives the wrap. That test is the reason this is three lines instead of eleven delegating
 * methods: it turns "the shape was copied faithfully" from something a reviewer has to check into
 * something the suite fails on. A getter added to `RikiContext` would break it and say so.
 */
export function observeContext(deps: ObservingContextDeps): RikiContext {
  const { delegate } = deps;

  return {
    ...delegate,

    openTurn(turn, now: MonoMs): TurnContext {
      const rendered = delegate.openTurn(turn, now);

      deps.onOpened({
        turnId: String(rendered.turnId),
        at: now,
        clock: deps.clock(),
        cause: turn.cause.by,
        // From the `CoachEvent` that opened the turn, never from the transcript — the same rule the
        // agent holds `agent_said.topics` to, and for the same reason.
        eventId: turn.cause.by === 'trigger' ? String(turn.cause.event) : null,
        salience: turn.cause.by === 'trigger' ? turn.cause.salience : null,
        snapshotText: rendered.snapshot.text,
        snapshotTokens: rendered.snapshot.tokens,
        briefText: rendered.brief.text,
        briefTokens: rendered.brief.tokens,
        briefSections: rendered.brief.sections.map((section) => String(section.id)),
        briefOmitted: rendered.brief.omitted.map(String),
        briefEmpty: rendered.brief.empty,
      });

      return rendered;
    },

    closeTurn(turnId: TurnId, outcome: TurnOutcome, now: MonoMs): void {
      delegate.closeTurn(turnId, outcome, now);
      deps.onClosed(String(turnId), outcome);
    },
  };
}

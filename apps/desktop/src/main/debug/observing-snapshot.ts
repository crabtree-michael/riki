/**
 * What the model was actually given, and what became of it.
 *
 * `SnapshotSource.render` produces the ~300 tokens a turn is answered from; the agent composes them
 * into one system message and forgets them. Nothing keeps the live text — `fixtures/golden/` only
 * shows what the renderer produces for a *fixture* — so the one rendering that matters, the one Riki
 * was about to answer on the strength of, has been the least inspectable thing in the process.
 *
 * This decorator observes `render` and reports what it produced. It returns the delegate's value
 * unchanged and decides nothing, which is ADR-0032's rule and the reason the inspector can be on
 * without moving what it measures.
 *
 * ## Why a decorator rather than a hook on the agent
 *
 * `createTurnAgent` would need a new optional dep and a call on the render path, and the debug
 * window's `scenario.speak` renders a snapshot without going through the agent at all — so a hook
 * there would miss it. The shell constructs the one `SnapshotSource` and injects it into both, so
 * wrapping it here covers every caller with no change to the code that has to stay correct when the
 * inspector is off.
 *
 * It replaced a decorator over `RikiContext`, which observed `openTurn`/`closeTurn` on the context
 * assembler. ADR-0042 deleted the assembler; what is left of a turn is the snapshot, so this is
 * where the seam moved. The `closeTurn` half has no equivalent — a turn resolves in the session's
 * event stream now, which the shell already subscribes to.
 */

import type { RenderedSnapshot, TurnId } from '@riki/context';
import type { MonoMs } from '@riki/world-model';

import type { SnapshotSource } from '../agent/index.js';
import type { DebugTurnOpenedInput } from './contracts.js';

export interface ObservingSnapshotDeps {
  readonly delegate: SnapshotSource;
  readonly onRendered: (turn: DebugTurnOpenedInput) => void;
  /** The match clock, for the turn's row. Read from the world model, not from the snapshot. */
  readonly clock: () => number | null;
  /**
   * How a turn observed here got started.
   *
   * `player` for everything the agent renders and `system` for the inspector's own `scenario.speak`,
   * which is the distinction the Turns panel needs so a button press is not presented as a question
   * somebody asked. A function rather than a constant because one source serves both.
   */
  readonly cause: () => string;
}

export function observeSnapshots(deps: ObservingSnapshotDeps): SnapshotSource {
  return {
    render(turnId: TurnId, now: MonoMs): RenderedSnapshot {
      const rendered = deps.delegate.render(turnId, now);

      deps.onRendered({
        turnId: String(rendered.turnId),
        at: now,
        clock: deps.clock(),
        cause: deps.cause(),
        snapshotText: rendered.text,
        snapshotTokens: rendered.tokens,
        snapshotOmitted: rendered.omitted.map(String),
      });

      return rendered;
    },
  };
}

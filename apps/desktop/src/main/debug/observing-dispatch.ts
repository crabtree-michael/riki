/**
 * What the model went and asked the world, and what it got back.
 *
 * ADR-0042 replaced a pre-assembled brief with five tools, which moves the interesting half of a
 * turn out of the snapshot and into a call the session makes mid-answer. A `function_call_output`
 * is composed, handed to the Realtime session and forgotten; nothing keeps it, and nothing else in
 * the process can say afterwards whether a tool was called at all. That is the question
 * conversational-architecture.md §10 says will need watching, so this is the seam that watches it.
 *
 * The same decorator shape as `observing-snapshot.ts`, for the same reason (ADR-0032): it returns
 * the delegate's answer unchanged, it decides nothing, and the dispatcher cannot tell it is there.
 * Two consequences are load-bearing and neither is decoration:
 *
 * - **A throw is an answer too, and it is re-thrown.** `packages/realtime` turns a failed call into
 *   a degraded reply rather than a dead turn (T4); swallowing the error here would change what the
 *   player hears, from the one component that is supposed to change nothing.
 * - **The call is recorded before it is made.** A dispatcher that hangs is exactly the failure
 *   worth seeing, and a row that only appears once a result lands would show a hang as nothing at
 *   all — which is how 2026-08-09's wedged gate stayed invisible for a whole match.
 *
 * ## What this cannot see
 *
 * A call that never reaches a dispatcher: a name that is not one of the five, or arguments the
 * schema rejects. `parseToolCall` refuses both before anything is dispatched, and refusing them is
 * right — but they are the model getting the tool surface wrong, which is the most interesting
 * thing it can do. `DebugHub.recordToolCall`/`recordToolResult` are public for that reason, and
 * `refused` is one of the four statuses: whoever wires the session's parse failure calls the hub
 * directly, and this decorator covers everything downstream of it.
 */

import type { ToolArgumentsFor, ToolName, ToolResultFor } from '@riki/protocol';
import type { ToolDispatcher } from '@riki/realtime';

import { DEBUG_LIMITS } from '../../shared/debug.js';
import type { DebugToolCallInput, DebugToolResultInput } from './contracts.js';
import { renderValue } from './projections.js';

export interface ObservingDispatchDeps {
  readonly delegate: ToolDispatcher;
  /** Main's monotonic clock. The hub has none, and a duration measured on two clocks is not one. */
  readonly now: () => number;
  /** Returns the `seq` the result will be joined on — `DebugHub.recordToolCall`. */
  readonly onCall: (call: DebugToolCallInput) => number;
  readonly onResult: (seq: number, result: DebugToolResultInput) => void;
}

export function observeToolCalls(deps: ObservingDispatchDeps): ToolDispatcher {
  return {
    async call<N extends ToolName>(name: N, args: ToolArgumentsFor<N>): Promise<ToolResultFor<N>> {
      const seq = deps.onCall({
        name,
        args: renderValue(args, DEBUG_LIMITS.toolArgsChars),
        at: deps.now(),
      });

      try {
        const result = await deps.delegate.call(name, args);
        deps.onResult(seq, {
          status: answeredUnknown(result) ? 'unknown' : 'ok',
          result: renderValue(result, DEBUG_LIMITS.toolResultChars),
          at: deps.now(),
        });
        return result;
      } catch (error) {
        deps.onResult(seq, {
          status: 'failed',
          result: String(error),
          at: deps.now(),
        });
        // See the header: the app must behave exactly as it does with the inspector off.
        throw error;
      }
    },
  };
}

/**
 * Whether the tool answered "nobody observed this" rather than answering.
 *
 * A **top-level** check, deliberately. Every result is `orUnknown(Report)`, so the whole answer
 * either is an `UnknownFact` or is a report whose individual fields may each be one (ADR-0043) —
 * and those two are different findings. "The tool had nothing at all" belongs on the call's status
 * row; "three of nine fields were unknown" belongs in the result JSON beside it, where somebody
 * reading a vague answer will find it. Counting the leaves would collapse them into one number
 * that answers neither.
 *
 * Structural rather than `isUnknown` from `@riki/protocol`, because that is typed against a
 * `ToolFact<T>` and what arrives here is a `ToolResultFor<N>` — the cast to make it fit would
 * assert precisely the thing being tested.
 */
function answeredUnknown(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'unknown' in result;
}

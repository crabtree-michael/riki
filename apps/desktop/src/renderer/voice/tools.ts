/**
 * The `ToolDispatcher` the Realtime session is given, backed by a request across the preload
 * bridge.
 *
 * ADR-0042 gave Riki five tools; T3 wrote them; T4 wired the round trip inside
 * `packages/realtime`. None of it fired in a real match, because the session runs in *this*
 * renderer and a `WorldState` may only be read in main (ADR-0002, ADR-0015) — so nothing could be
 * injected here and every live session went out with `tools: []`. This file is the missing half:
 * `call()` puts a `voice.tool.call` on the bridge and resolves when main answers it.
 *
 * ## Why it can never reject, and never wait forever
 *
 * A tool call is the only `await` inside a response that is **already being spoken** (ADR-0049).
 * Every branch here is a decision about what the player hears in the next second, and there are
 * only three: the sentence continues with a fact, it continues with "I do not know", or it stops.
 * The third is the one a voice product cannot absorb, so it is not reachable from this file.
 *
 * That makes the timeout load-bearing rather than defensive. A directive sent into a main process
 * that is wedged, mid-quit, or simply has no dispatcher wired produces **no error of any kind** —
 * the same shape of failure this whole area keeps rediscovering — and without a deadline the
 * promise would sit in `answerToolCall` until the session closed, with the response held open
 * behind it. So the deadline answers on main's behalf, in the shape `orUnknown` already accepts.
 *
 * ## The one thing a silent timeout must not be is silent
 *
 * ADR-0049 is explicit that a broken tool layer is quiet: every call degrades politely, the
 * answers get vaguer, and nothing sounds wrong. A bridge that timed out on every call would be
 * indistinguishable from the state T12 exists to leave — which is why `onTimeout` is a required
 * dependency rather than an optional hook. It lands on `VoiceTelemetry.toolCallRejected`, beside
 * the parse failures `packages/realtime` counts, and that counter is the only evidence anybody
 * gets.
 *
 * ## What is *not* here
 *
 * Whether tools are advertised at all. That is main's answer — it owns the dispatcher — and it
 * arrives as `VoiceSessionOpen.tools`, which `host.ts` reads. A dispatcher constructed here is one
 * main has already promised to answer.
 */

import type { ToolName, ToolArgumentsFor, ToolResultFor, VoiceUpdate } from '@riki/protocol';
import { voiceUpdates } from '@riki/protocol';
import type { ToolDispatcher } from '@riki/realtime';

/**
 * How long main gets before the renderer answers for it.
 *
 * Generous, because the alternative to waiting is a vaguer answer and the tools it protects are
 * an in-memory projection of a `WorldState` — microseconds when anything is working at all. The
 * number is a deadline for a wedged process, not a latency budget: a value tight enough to trip
 * on a slow tool would silently make Riki worse at exactly the moments main is busiest.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 2_000;

export interface BridgeToolDispatcherDeps {
  /** Puts one `voice.tool.call` on the bridge. `host.ts`'s `bridge.send`. */
  readonly send: (update: VoiceUpdate) => void;
  /**
   * The renderer's timer. Required, unlike the host's — see the header: a dispatcher with no
   * deadline is one that can hold a spoken response open on a main process that will never answer.
   */
  readonly schedule: (delayMs: number, fire: () => void) => () => void;
  /** `VoiceTelemetry.toolCallRejected`. The only evidence a wedged bridge produces. */
  readonly onTimeout: (name: ToolName, callId: string) => void;
  /** Defaults to `DEFAULT_TOOL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export interface BridgeToolDispatcher extends ToolDispatcher {
  /**
   * Hand back what arrived on a `voice.tool.result`.
   *
   * Returns false when nothing was waiting on that `callId` — a result for a call the deadline
   * already answered, which is ordinary rather than an error: main cannot know our timeout fired,
   * and the model has been told something true either way. Reported so the caller can trace it.
   */
  settle(callId: string, result: Record<string, unknown>): boolean;
  /** Answer everything still in flight with an unknown. The session is going away. */
  abandon(reason: string): void;
  /** Calls awaiting an answer. Non-zero after a turn ends means a call outlived its response. */
  readonly pending: number;
}

export function createBridgeToolDispatcher(deps: BridgeToolDispatcherDeps): BridgeToolDispatcher {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  /** `callId` → how to answer it. Removing the entry is what makes an answer happen once. */
  const waiting = new Map<
    string,
    { readonly name: ToolName; readonly answer: (result: Record<string, unknown>) => void }
  >();

  /**
   * Sequence numbers, not random ids — the same choice `voice/session.ts` makes for turn ids, and
   * for the same reason: a fixture-driven test has to be able to reproduce them.
   */
  let counter = 0;

  const take = (callId: string): ((result: Record<string, unknown>) => void) | null => {
    const entry = waiting.get(callId);
    if (entry === undefined) return null;
    waiting.delete(callId);
    return entry.answer;
  };

  return {
    get pending(): number {
      return waiting.size;
    },

    async call<N extends ToolName>(name: N, args: ToolArgumentsFor<N>): Promise<ToolResultFor<N>> {
      counter += 1;
      const callId = `tool_${String(counter)}`;

      const result = await new Promise<Record<string, unknown>>((resolve) => {
        let cancel: (() => void) | null = null;

        // Registered before the send, and the order is not decorative: a bridge that answers
        // synchronously — which is what a test's is — would otherwise find nothing waiting.
        waiting.set(callId, {
          name,
          answer: (value) => {
            cancel?.();
            resolve(value);
          },
        });

        cancel = deps.schedule(timeoutMs, () => {
          const answer = take(callId);
          if (answer === null) return;
          deps.onTimeout(name, callId);
          answer({
            unknown: `\`${name}\` did not answer within ${String(timeoutMs)} ms — Riki cannot reach its game state`,
          });
        });

        deps.send(voiceUpdates.toolCall(callId, name, args));
      });

      // The one cast in this file, and it is checked a layer later rather than trusted:
      // `callTool` hands what we return to `encodeToolOutput`, which looks the schema up by name
      // and parses against it, so a result that is not a `ToolResultFor<N>` comes back to the
      // model as an `unknown` instead of as a lie (ADR-0049).
      return result as ToolResultFor<N>;
    },

    settle(callId, result): boolean {
      const answer = take(callId);
      if (answer === null) return false;
      answer(result);
      return true;
    },

    abandon(reason): void {
      const outstanding = [...waiting.keys()];
      for (const callId of outstanding) {
        const answer = take(callId);
        answer?.({ unknown: reason });
      }
    },
  };
}

/**
 * Function-call accumulation — the wire half of "command parsing", and no more than that.
 *
 * The seam is drawn precisely in agent-command-execution-architecture.md §1.1: that component
 * "does not own the wire… It never sees the string `response.function_call_arguments.done`", and
 * this one never sees a hero name. What crosses between them is C2's shape — a `call_id`, a name,
 * and **arguments as a JSON string accumulated from deltas**. Schema validation, subject
 * resolution, admission and execution all live in `packages/context/src/tools`, behind the
 * composition root's `ToolCallBridge`.
 *
 * So this file does exactly one thing: turn a stream of deltas into that string. It does not
 * `JSON.parse` the result, and it must not start — a malformed-argument failure has a defined
 * home in the other component's failure taxonomy, and parsing here would turn it into a wire
 * fault that kills the session instead.
 */

import type { ToolCall } from '../types.js';

interface PartialCall {
  name: string | null;
  chunks: string[];
}

export class ToolCallAccumulator {
  readonly #partial = new Map<string, PartialCall>();

  /**
   * `name` arrives on the first delta and is absent from the rest, so it is captured once and
   * kept. A `done` for a call we never saw a delta for is still valid — the API may deliver the
   * whole argument string at once — which is why `done` does not require prior state.
   */
  delta(callId: string, name: string | null, chunk: string): void {
    const existing = this.#partial.get(callId);
    if (existing) {
      if (name !== null && existing.name === null) existing.name = name;
      if (chunk !== '') existing.chunks.push(chunk);
      return;
    }
    this.#partial.set(callId, { name, chunks: chunk === '' ? [] : [chunk] });
  }

  /**
   * `arguments` on the `done` event carries the complete string, so it wins over the accumulated
   * chunks when present. Falling back to the chunks matters for replayed fixtures and for the
   * case where the final event is truncated.
   */
  done(callId: string, argumentsJson: string): ToolCall | null {
    const partial = this.#partial.get(callId);
    this.#partial.delete(callId);

    const accumulated = partial?.chunks.join('') ?? '';
    const args = argumentsJson !== '' ? argumentsJson : accumulated;
    const name = partial?.name ?? null;

    // Without a name there is nothing for the registry to dispatch on, and inventing one would
    // surface as an unknown-command error two layers away from the actual problem.
    if (name === null) return null;

    return { callId, name, argumentsJson: args };
  }

  /**
   * Barge-in and abort both discard calls in flight. agent-command-execution §6 cancels the
   * queue on the same edge; this drops the half-assembled arguments so a later call with a
   * recycled id cannot inherit them.
   */
  clear(): void {
    this.#partial.clear();
  }

  get pending(): number {
    return this.#partial.size;
  }
}

/**
 * Turn scope — everything with a lifetime shorter than the match has this lifetime instead.
 *
 * The scope exists because of barge-in. When the player interrupts, `packages/realtime` truncates
 * the conversation item, and any command result still in flight belongs to a message that no longer
 * exists. Submitting it would inject an answer to a question the conversation no longer contains.
 * So cancellation is not an optimisation to save work — it is a correctness requirement, and
 * scoping it to a turn is what makes it a single call.
 *
 * See docs/design/agent-command-execution-architecture.md §3.5, §6.4, §6.5.
 */

import type {
  CallFingerprint,
  CancelReason,
  CancelSignal,
  MonoMs,
  ResultMemo,
  ToolResultMessage,
  TurnId,
  TurnScope,
  Unsubscribe,
} from './types.js';

/**
 * Fires once, then stays fired.
 *
 * A listener registered after cancellation is called immediately rather than never — the
 * alternative is a race in which a handler that subscribed one microtask late runs to completion
 * against a turn that is already gone.
 */
export class MutableCancelSignal implements CancelSignal {
  #reason: CancelReason | null = null;
  readonly #listeners = new Set<(reason: CancelReason) => void>();

  get cancelled(): boolean {
    return this.#reason !== null;
  }

  get reason(): CancelReason | null {
    return this.#reason;
  }

  onCancel(fn: (reason: CancelReason) => void): Unsubscribe {
    if (this.#reason !== null) {
      fn(this.#reason);
      return () => undefined;
    }
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  cancel(reason: CancelReason): void {
    if (this.#reason !== null) return;
    this.#reason = reason;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) listener(reason);
  }
}

/**
 * Same question twice in a turn costs one execution.
 *
 * The model repeats itself, particularly under interruption and particularly with zero-argument
 * commands. Joining the in-flight promise rather than starting a second execution is what stops one
 * repeated `get_minimap_summary` from becoming two capture requests (§6.4).
 */
export class TurnResultMemo implements ResultMemo {
  readonly #done = new Map<CallFingerprint, ToolResultMessage>();
  readonly #running = new Map<CallFingerprint, Promise<ToolResultMessage>>();

  get(fp: CallFingerprint): ToolResultMessage | undefined {
    return this.#done.get(fp);
  }

  set(fp: CallFingerprint, result: ToolResultMessage): void {
    this.#done.set(fp, result);
    this.#running.delete(fp);
  }

  inflight(fp: CallFingerprint): Promise<ToolResultMessage> | undefined {
    return this.#running.get(fp);
  }

  /** Registered before execution starts, so a duplicate arriving one tick later joins rather than races. */
  begin(fp: CallFingerprint, run: Promise<ToolResultMessage>): void {
    this.#running.set(fp, run);
  }

  forget(fp: CallFingerprint): void {
    this.#running.delete(fp);
  }
}

export class Turn implements TurnScope {
  readonly turnId: TurnId;
  readonly openedAt: MonoMs;
  readonly deadlineAt: MonoMs;
  readonly memo = new TurnResultMemo();
  readonly #signal = new MutableCancelSignal();
  #spent = 0;

  constructor(turnId: TurnId, openedAt: MonoMs, deadlineMs: number) {
    this.turnId = turnId;
    this.openedAt = openedAt;
    this.deadlineAt = (openedAt + deadlineMs) as MonoMs;
  }

  get signal(): CancelSignal {
    return this.#signal;
  }

  spentTokens(): number {
    return this.#spent;
  }

  noteTokens(n: number): void {
    this.#spent += n;
  }

  cancel(reason: CancelReason): void {
    this.#signal.cancel(reason);
  }
}

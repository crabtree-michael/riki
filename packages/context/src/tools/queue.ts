/**
 * Turn-scoped queueing, per effect class.
 *
 * The queue exists because the agent may issue several commands for one turn, and because two of
 * the four effect classes must not run concurrently with themselves. It is **per effect class, not
 * global**: a `model` read waiting behind a `read_screen` would be absurd — a memory access queued
 * behind a network round trip.
 *
 * See docs/design/agent-command-execution-architecture.md §6.
 *
 * ⚠ The `enqueue` signature takes an entry object rather than the four positional parameters the
 * scaffolded contract declared. The queue needs the scope (for the cancel signal it hands to `run`)
 * and the effective deadline (to release a lane slot when a handler hangs, §7.4) — with neither, a
 * hung `observe` handler blocks the one `observe` slot for the rest of the match.
 */

import type { QueueEntry, QueueOutcome, ToolQueue } from './contracts.js';
import type { CancelReason, MonoMs, ToolEffect, TurnId } from './types.js';
import type { Clock } from '../common/types.js';
import type { Timers } from './timers.js';
import { MutableCancelSignal } from './turn.js';
import { fail } from './failures.js';
import { EFFECT_DEFAULTS } from './tunables.js';
import { systemTimers } from './timers.js';

interface Waiting {
  readonly turnId: TurnId;
  readonly effect: ToolEffect;
  readonly start: () => void;
  readonly abandon: (reason: CancelReason) => void;
}

export interface QueueOptions {
  readonly clock: Clock;
  readonly timers?: Timers;
  /** Lane widths. Defaults are the §3.2 table; a test narrows them to make contention observable. */
  readonly maxInFlight?: Partial<Record<ToolEffect, number>>;
  /**
   * Called when a handler returns *after* its watchdog already answered `timeout`.
   *
   * The value is discarded — the result for that call has been submitted and there is exactly one
   * per `callId` — but it is counted, because a non-zero rate here is the signal that a deadline is
   * set too tight rather than that a port is broken (§7.4).
   */
  readonly onLateValue?: () => void;
}

export function createToolQueue(options: QueueOptions): ToolQueue {
  const timers = options.timers ?? systemTimers;
  const widths: Record<ToolEffect, number> = {
    model: options.maxInFlight?.model ?? EFFECT_DEFAULTS.model.maxInFlight,
    reference: options.maxInFlight?.reference ?? EFFECT_DEFAULTS.reference.maxInFlight,
    observe: options.maxInFlight?.observe ?? EFFECT_DEFAULTS.observe.maxInFlight,
    consequential: options.maxInFlight?.consequential ?? EFFECT_DEFAULTS.consequential.maxInFlight,
  };

  const running: Record<ToolEffect, number> = {
    model: 0,
    reference: 0,
    observe: 0,
    consequential: 0,
  };
  const waiting: Waiting[] = [];

  /** Start whatever now fits, oldest first within a lane. FIFO is the only fair order here. */
  const pump = (): void => {
    for (let i = 0; i < waiting.length; i += 1) {
      const entry = waiting[i];
      if (entry === undefined) continue;
      if (running[entry.effect] >= widths[entry.effect]) continue;
      waiting.splice(i, 1);
      i -= 1;
      running[entry.effect] += 1;
      entry.start();
    }
  };

  return {
    async enqueue<T>(entry: QueueEntry<T>): Promise<QueueOutcome<T>> {
      const { call, effect, scope, deadlineAt, run } = entry;

      if (scope.signal.cancelled) {
        return {
          ran: false,
          failure: fail('cancelled', { detail: scope.signal.reason ?? 'cancelled' }),
        };
      }

      return new Promise<QueueOutcome<T>>((resolve) => {
        let settled = false;
        let started = false;
        let releasedSlot = false;
        // Assigned below and only ever *called* from a callback, which cannot run before then.
        let cancelTimer: () => void = () => undefined;

        const finish = (outcome: QueueOutcome<T>): void => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        const release = (): void => {
          if (releasedSlot || !started) return;
          releasedSlot = true;
          running[effect] -= 1;
          pump();
        };
        const drop = (): void => {
          const index = waiting.indexOf(item);
          if (index >= 0) waiting.splice(index, 1);
        };

        const signal = new MutableCancelSignal();
        const unsubscribe = scope.signal.onCancel((reason) => {
          signal.cancel(reason);
        });

        // The per-call watchdog, and the reason a lane slot is never held by a hung handler.
        // Nothing prevents a handler from never settling — a promise that never resolves is always
        // possible — so the guarantee has to come from outside it (§7.4).
        cancelTimer = timers.after(Math.max(0, deadlineAt - options.clock.now()), () => {
          const wasRunning = started;
          unsubscribe();
          finish({
            ran: false,
            failure: fail('timeout', {
              detail: `${call.name}: ${wasRunning ? 'handler' : 'queued'} past deadline`,
            }),
          });
          if (wasRunning) release();
          else drop();
        });

        const item: Waiting = {
          turnId: call.turnId,
          effect,
          abandon: (reason) => {
            cancelTimer();
            unsubscribe();
            finish({ ran: false, failure: fail('cancelled', { detail: reason }) });
          },
          start: () => {
            started = true;

            // A call that waited out the turn is not executed: the work might have been quick, but
            // a result arriving after the model has already spoken is worse than useless — it is
            // context the retention policy carries for the rest of the match having contributed
            // nothing (§6.3).
            if (options.clock.now() >= deadlineAt) {
              cancelTimer();
              unsubscribe();
              finish({
                ran: false,
                failure: fail('timeout', {
                  detail: `${call.name}: turn deadline passed while queued`,
                }),
              });
              release();
              return;
            }

            void (async () => {
              try {
                const value = await run(signal);
                if (settled) options.onLateValue?.();
                finish({ ran: true, value });
              } catch (error) {
                // A handler that throws is `internal` at the executor; the queue only has to not
                // let the rejection escape and leave the lane occupied.
                finish({
                  ran: false,
                  failure: fail('internal', {
                    detail: `${call.name}: ${error instanceof Error ? error.message : 'threw'}`,
                  }),
                });
              } finally {
                cancelTimer();
                unsubscribe();
                release();
              }
            })();
          },
        };

        waiting.push(item);
        pump();
      });
    },

    cancel(turnId: TurnId, reason: CancelReason): void {
      // Queued calls answer `cancelled` and are never executed. In-flight handlers see the signal
      // through the scope they were enqueued with and unwind on their own (§6.5).
      for (const entry of [...waiting]) {
        if (entry.turnId !== turnId) continue;
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        entry.abandon(reason);
      }
    },

    depth(): ReadonlyMap<ToolEffect, number> {
      const depths = new Map<ToolEffect, number>([
        ['model', 0],
        ['reference', 0],
        ['observe', 0],
        ['consequential', 0],
      ]);
      for (const entry of waiting) {
        depths.set(entry.effect, (depths.get(entry.effect) ?? 0) + 1);
      }
      return depths;
    },
  };
}

/** min(the command's own limit, what is left of the turn) — the effective deadline (§6.3). */
export function effectiveDeadline(
  now: MonoMs,
  commandDeadlineMs: number,
  turnDeadlineAt: MonoMs,
): MonoMs {
  return Math.min(now + commandDeadlineMs, turnDeadlineAt) as MonoMs;
}

/**
 * Every number the architecture marks *(tunable)*, in one place.
 *
 * They are starting points to be measured, not measurements (§0 C7). Collecting them here means a
 * measurement changes one literal rather than hunting through six modules, and it means a test can
 * pass its own values instead of waiting 1200 ms of real time to watch a deadline fire.
 *
 * See docs/design/agent-command-execution-architecture.md §3.2, §6.3, §7.3, §8.
 */

import type { ToolEffect, ToolLimits } from './types.js';

export interface ToolTunables {
  /**
   * Wall-clock ceiling for *all* command work in one turn.
   *
   * The budget that actually matters: realtime §7 puts the conversational latency floor at 1–2 s
   * already and command work is added to it, so a turn that spends 3 s gathering perfect detail
   * has produced a coach who answers after the fight.
   */
  readonly turnDeadlineMs: number;
  /** Token ceiling for command output in one turn (§8.2). */
  readonly turnResultTokens: number;
  /** Manifest ceiling. Every command is a permanent tax on the cached prefix (§8.1). */
  readonly manifestMaxTokens: number;
  /** Consecutive failures that open a port's breaker (§7.3). */
  readonly breakerFailureThreshold: number;
  readonly breakerCooldownMs: number;
  /** How long a consent prompt stays up before it becomes `expired` rather than `denied`. */
  readonly consentTimeoutMs: number;
  /** Below this, a CV fact is dropped rather than hedged (dota2 §4). */
  readonly confidenceFloor: number;
}

export const DEFAULT_TUNABLES: ToolTunables = {
  turnDeadlineMs: 1200,
  turnResultTokens: 600,
  manifestMaxTokens: 2000,
  breakerFailureThreshold: 3,
  breakerCooldownMs: 15_000,
  consentTimeoutMs: 8_000,
  confidenceFloor: 0.5,
};

/**
 * What the effect class decides, so that adding a command does not mean deciding it again (§3.2).
 *
 * `maxInFlight` is the queue lane width:
 *
 * - `model` is unbounded because it is a memory read wearing a promise.
 * - `reference` is 2, to stay polite to an external API.
 * - `observe` is 1 because a second concurrent request for the same region is strictly wasted —
 *   the first one's detections land in the model and the second answers from the same version.
 *   Deduplication turns the second call into a wait on the first (§6.4).
 * - `consequential` is 1, and at most one per turn: more than one screenshot per question is not
 *   something a player would expect, and the rate limit would refuse it anyway.
 */
export interface EffectDefaults {
  readonly maxInFlight: number;
  readonly limits: ToolLimits;
}

export const EFFECT_DEFAULTS: Readonly<Record<ToolEffect, EffectDefaults>> = {
  model: {
    maxInFlight: Number.POSITIVE_INFINITY,
    limits: {
      deadlineMs: 20,
      // The class default is the *largest* §8.2 allows any member — `get_recent_events` at 200 —
      // and the narrower commands tighten to their own number. The other direction does not work:
      // an override may only tighten, so a class default below a member's budget is unbuildable,
      // which is how this number was found rather than guessed.
      maxResultTokens: 200,
      minIntervalMs: 0,
      maxPerTurn: 8,
      maxPerMatch: null,
      consent: 'none',
      cache: 'turn',
    },
  },
  reference: {
    maxInFlight: 2,
    limits: {
      deadlineMs: 400,
      maxResultTokens: 120,
      minIntervalMs: 0,
      maxPerTurn: 4,
      maxPerMatch: null,
      consent: 'none',
      cache: 'patch',
    },
  },
  observe: {
    maxInFlight: 1,
    limits: {
      deadlineMs: 600,
      maxResultTokens: 150,
      minIntervalMs: 0,
      maxPerTurn: 2,
      maxPerMatch: null,
      consent: 'none',
      cache: 'turn',
    },
  },
  consequential: {
    maxInFlight: 1,
    limits: {
      deadlineMs: 2500,
      maxResultTokens: 300,
      // dota2 §5 caps `read_screen` at 0.2 Hz. Enforced at admission so a refused call costs
      // nothing and still answers (§4.4).
      minIntervalMs: 5_000,
      maxPerTurn: 1,
      maxPerMatch: null,
      consent: 'per_call',
      cache: 'none',
    },
  },
};

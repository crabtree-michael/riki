/**
 * The fifth shared fake, and the reason every other file in this package is a Tier 1 test.
 *
 * REPO_SKELETON.md §5.2: **no test may require a live OpenAI session.** `FakeCoachModel` is what
 * makes that possible here — it records every stimulus it was handed and replies from a script, so
 * `coach.test.ts` can assert which consultations happened, what they contained, and what the coach
 * did with each answer, without a key and without a network.
 *
 * The three replies that matter are the three that are easy to forget to test: a decline, a failure
 * (`null`), and a slow answer that arrives after the coach was disposed.
 */

import type { MonoMs } from '@riki/world-model';
import type { CoachModel, WorldNarrator } from '../contracts.js';
import type { CoachJudgement, CoachStimulus } from '../types.js';

/**
 * A reply, or the instruction to fail. `null` is what `CoachModel` returns for a failed run.
 *
 * A **function** is the form most tests want, and it is not a convenience: a judgement that speaks
 * has to name one of the signals it was shown by key (`coach.ts`, the ADR-0013 invariant), and the
 * keys are not knowable until the stimulus exists — `enemy_missing:sf` depends on who went missing.
 * A test that pushes a literal judgement with a guessed key is testing the discard path by accident.
 */
export type ScriptedReply =
  CoachJudgement | null | ((stimulus: CoachStimulus) => CoachJudgement | null);

export interface FakeCoachModel extends CoachModel {
  /** Every stimulus, in order. The Tier 1 assertion for the whole consultation path. */
  readonly seen: readonly CoachStimulus[];
  /** Queue another reply. Exhausting the script yields `null` — a failed run, not a hang. */
  push(reply: ScriptedReply): void;
  /** Hold the next reply until `release()`. For asserting `in_flight`. */
  block(): void;
  release(): void;
  readonly closed: boolean;
}

export interface FakeCoachModelOptions {
  readonly script?: readonly ScriptedReply[];
}

export function createFakeCoachModel(options: FakeCoachModelOptions = {}): FakeCoachModel {
  const seen: CoachStimulus[] = [];
  const script: ScriptedReply[] = [...(options.script ?? [])];
  let gate: (() => void) | null = null;
  let blocked = false;
  let closed = false;

  return {
    seen,
    get closed(): boolean {
      return closed;
    },

    push(reply: ScriptedReply): void {
      script.push(reply);
    },

    block(): void {
      blocked = true;
    },

    release(): void {
      blocked = false;
      const resume = gate;
      gate = null;
      resume?.();
    },

    async judge(stimulus: CoachStimulus): Promise<CoachJudgement | null> {
      seen.push(stimulus);
      if (blocked) {
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
      }
      // Exhausted script means a failed run. Deliberately not a throw: `CoachModel.judge` is
      // specified to resolve, and a fake that rejects would let a test pass against a coach that
      // only works because the fake never exercised the `null` arm.
      const next = script.shift() ?? null;
      return typeof next === 'function' ? next(stimulus) : next;
    },

    close(): Promise<void> {
      closed = true;
      // A blocked call left waiting on dispose would keep a promise alive for the rest of the run.
      const resume = gate;
      gate = null;
      resume?.();
      return Promise.resolve();
    },
  };
}

/**
 * A judgement that speaks, with everything else defaulted.
 *
 * ⚠ `about` defaults to `null`, which the coach **discards** — a judgement that speaks must name one
 * of the signals it was shown. That default is deliberate rather than convenient: it is the one the
 * `unattributed` path needs, and leaving it as the default means a test that forgets to name a
 * signal fails loudly instead of passing against an invariant nobody checked.
 *
 * To make a judgement that is actually spoken, script a function and read the key off the stimulus:
 * `model.push((s) => speaks('…', { about: s.signals[0]?.key ?? null }))`, or use `speaksAbout`.
 */
export function speaks(say: string, overrides: Partial<CoachJudgement> = {}): CoachJudgement {
  return {
    speak: true,
    reasoning: 'worth saying',
    say,
    about: null,
    weight: 0.5,
    ...overrides,
  };
}

/**
 * A judgement that speaks about whichever signal the stimulus led with — the common case.
 *
 * Returns a `ScriptedReply` rather than a `CoachJudgement`, because the key it needs does not exist
 * until the coach has built the stimulus.
 */
export function speaksAbout(say: string, overrides: Partial<CoachJudgement> = {}): ScriptedReply {
  return (stimulus: CoachStimulus): CoachJudgement =>
    speaks(say, { about: stimulus.signals[0]?.key ?? null, ...overrides });
}

/** A judgement that stays quiet. The expected answer, so it is the shorter helper. */
export function declines(reasoning = 'nothing worth saying'): CoachJudgement {
  return { speak: false, reasoning, say: null, about: null, weight: 0 };
}

/** A narrator that always says the same thing. `''` exercises the `no_world` skip. */
export function fixedNarrator(text: string): WorldNarrator {
  return { narrate: (): string => text };
}

// There was a `ManualTimers` here, for cranking the cadence tick by hand. The coach is push-only,
// so there is no tick and nothing left for it to crank. `@riki/context/testing` still ships one for
// the preamble's enrichment deadline, which is the only deadline left in the product.

/** A clock a test steps by hand, in the same shape `@riki/world-model` injects everywhere. */
export interface ManualClock {
  now(): MonoMs;
  advance(ms: number): void;
  set(ms: number): void;
}

export function createManualClock(start = 0): ManualClock {
  let value = start;
  return {
    now: (): MonoMs => value as MonoMs,
    advance(ms: number): void {
      value += ms;
    },
    set(ms: number): void {
      value = ms;
    },
  };
}

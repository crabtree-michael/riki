/**
 * The toggle, as one interface and two adapters.
 *
 * `packages/events` and `packages/coach` answer the same question — *should Riki speak right now,
 * and about what* — and this file is where the composition root stops caring which one is doing it.
 * Neither package knows the other exists, and neither has an import of this file; the whole of the
 * coupling is the two functions below, each about twenty lines.
 *
 * ## Why the port is shaped like `EventEngine` and not like something new
 *
 * The four setters, `start`, a disposer and two subscriptions are exactly what `agent/index.ts`
 * already used, so the deterministic side of this file is a rename and the LLM side had to be built
 * to fit. That direction is deliberate: the deterministic coach is the baseline and requirement 7
 * keeps it intact, so it is the thing that must not move.
 *
 * ## The one field that is not in `CoachEvent`
 *
 * `guidance`. The deterministic coach names a moment and lets `BRIEF_PLAN` decide what the model is
 * shown for it; the LLM coach has already read the world and drafted the line. So a proposal from
 * `packages/events` carries `guidance: null` and the brief is the whole of what is injected, and a
 * proposal from `packages/coach` carries a line that is injected **alongside** the brief rather than
 * instead of it — `index.ts`'s `inject` is where that happens and says why.
 *
 * See docs/design/llm-coach-architecture.md §6.
 */

import type { EventId } from '@riki/context';
import type { CoachEvent, EventEngine, SuppressionReason } from '@riki/events';
import type { CoachCounters, LlmCoach } from '@riki/coach';
import { SKIP_REASONS, eventIdOf } from '@riki/coach';
import type { MonoMs } from '@riki/world-model';
import type { CoachConsultation, CoachDriver, CoachProposal } from './contracts.js';

/**
 * The adapters keep a handle on what they wrapped, and the port does not.
 *
 * `index.ts` is typed against `CoachDriver` and therefore cannot reach either — which is the
 * property the port exists for. What *can* is a caller that already knows which mode it asked for:
 * `shell.test.ts` narrows on `driver.mode` to read the thirteen suppression counters, and telemetry
 * will want the same. Two counter shapes that share no fields cannot go on one interface without
 * inventing a third, and inventing one would be a vocabulary nobody speaks.
 */
export interface StaticCoachDriver extends CoachDriver {
  readonly mode: 'static';
  readonly engine: EventEngine;
}

export interface LlmCoachDriver extends CoachDriver {
  readonly mode: 'llm';
  readonly coach: LlmCoach;
}

/**
 * `packages/events`, behind the port.
 *
 * Every method is the engine's own, and the only translation is `CoachEvent` → `CoachProposal`:
 * three fields copied and a fourth set to null. `id` and `topic` are copied rather than derived,
 * which is the same rule the engine itself holds — `CoachEventKind` and `EventId` are the same
 * string seen from two packages, and translating between them would be a second table.
 */
export function staticCoachDriver(engine: EventEngine): StaticCoachDriver {
  return {
    mode: 'static',
    engine,

    start: () => engine.start(),

    onProposal(listener): () => void {
      return engine.onCoachEvent((event: CoachEvent) => {
        listener({
          id: event.id,
          topic: event.topic,
          salience: event.salience,
          guidance: null,
          at: event.at,
        });
      });
    },

    onDeclined(listener): () => void {
      // The engine reports a `SuppressionReason` and an event; the port takes one string, because
      // the LLM coach's equivalent is a sentence and there is no union that could hold both. The
      // fine-grained accounting stays where it always was — `engine.counters()`, per gate — and
      // this is only what reaches the ledger.
      return engine.onSuppressed((reason: SuppressionReason) => {
        listener(reason);
      });
    },

    setAgentSpeaking: (speaking) => {
      engine.setAgentSpeaking(speaking);
    },
    setPlayerSpeaking: (speaking) => {
      engine.setPlayerSpeaking(speaking);
    },
    setQuietMode: (on) => {
      engine.setQuietMode(on);
    },
    setMuted: (until: MonoMs | null) => {
      engine.setMuted(until);
    },

    /**
     * `evaluate`, widened to the port's vocabulary.
     *
     * Synchronous underneath and wrapped in a resolved promise, which is the honest shape: the
     * deterministic coach cannot fail to answer and cannot take time to do it.
     *
     * `event === null` — the detectors produced nothing at all — is not a refusal, and the engine
     * pointedly does not count it as one. It still has to become a string here, because the caller
     * asked a question and "no reason, there was nothing" is an answer. `no_candidates` is the one
     * word in this file that is not a `SuppressionReason`, and it is spelled unlike any of the
     * thirteen so it cannot be mistaken for one.
     */
    consult: (now: MonoMs): Promise<CoachConsultation> => {
      const decision = engine.evaluate(now);
      if (decision.speak) {
        return Promise.resolve({
          spoke: true,
          proposal: {
            id: decision.event.id,
            topic: decision.event.topic,
            salience: decision.event.salience,
            guidance: null,
            at: decision.event.at,
          },
        });
      }
      return Promise.resolve({
        spoke: false,
        reason: decision.event === null ? 'no_candidates' : decision.reason,
      });
    },

    dispose: () => {
      engine.dispose();
    },
  };
}

/**
 * `packages/coach`, behind the same port.
 *
 * **Both `id` and `topic` come off the detector, not off the model** — which is the ADR-0013
 * invariant arriving here already satisfied rather than being repaired. `packages/coach` makes the
 * model name one of the signals it was shown, resolves that key back to the `CoachSignal` it sent,
 * and puts the detector's own `kind` and `topic` on the utterance; a judgement naming anything else
 * is discarded inside the package and never reaches this file. So this adapter copies, exactly as
 * `staticCoachDriver` copies from `CoachEvent`, and there is no arm here that could synthesise a
 * topic — which is the property that makes the two coaches interchangeable at all.
 *
 * `eventIdOf` is the one assertion that a `CoachEventKind` is an `EventId`: the same eight strings
 * declared in two packages so neither waits for the other to compile (coaching-architecture.md
 * §4.4).
 */
export function llmCoachDriver(coach: LlmCoach): LlmCoachDriver {
  return {
    mode: 'llm',
    coach,

    start: () => coach.start(),

    onProposal(listener): () => void {
      return coach.onUtterance((utterance) => {
        listener({
          id: eventIdOf(utterance.kind),
          topic: utterance.topic,
          // The model's own `weight`, in `salience`'s slot. Nothing compares it to a threshold —
          // the model already decided — and putting it here is what makes the ledger and the
          // telemetry read the same under both coaches.
          salience: utterance.weight,
          guidance: utterance.say,
          at: utterance.at,
        });
      });
    },

    onDeclined: (listener) => coach.onDeclined(listener),

    setAgentSpeaking: (speaking) => {
      coach.setAgentSpeaking(speaking);
    },
    setPlayerSpeaking: (speaking) => {
      coach.setPlayerSpeaking(speaking);
    },
    setQuietMode: (on) => {
      coach.setQuietMode(on);
    },
    setMuted: (until: MonoMs | null) => {
      coach.setMuted(until);
    },

    /**
     * `LlmCoach.consult`, plus the work of finding out *why* when it answers null.
     *
     * The push path does not need this and therefore does not do it: a decline is announced through
     * `onDeclined`, and a **skip** — quiet mode, a turn already open, a world with nothing in it —
     * is announced nowhere at all, because on the push path there is nothing waiting for an answer.
     * A caller that asked a question is owed one, so the two are reconstructed here:
     *
     * - The model's own sentence, caught off `onDeclined` for the length of the call.
     * - Otherwise the counters, which are the coach's tuning surface (§7) and whose *difference*
     *   across one consultation names exactly what happened to it.
     *
     * ⚠ The listener is global to the coach, so a decline from a concurrent push consultation would
     * be attributed here. `in_flight` makes that unreachable for the coach the rehearsal builds —
     * one judgement at a time, and nothing else holds a reference to it — and this method has no
     * other caller.
     */
    consult: async (now: MonoMs): Promise<CoachConsultation> => {
      const before = coach.counters();
      // A holder rather than a `let`: TypeScript does not track an assignment made inside a
      // callback, so a plain binding would narrow to `null` and the `??` below would be dead code.
      const declined: { reason: string | null } = { reason: null };
      const stop = coach.onDeclined((reason) => {
        declined.reason = reason;
      });

      try {
        const utterance = await coach.consult(now);
        if (utterance === null) {
          return { spoke: false, reason: declined.reason ?? whyNot(before, coach.counters()) };
        }
        return {
          spoke: true,
          proposal: {
            id: eventIdOf(utterance.kind),
            topic: utterance.topic,
            salience: utterance.weight,
            guidance: utterance.say,
            at: utterance.at,
          },
        };
      } finally {
        stop();
      }
    },

    dispose: () => {
      coach.dispose();
    },
  };
}

/**
 * What happened to a consultation that produced neither an utterance nor a sentence.
 *
 * Every arm is a counter that rose, so this cannot invent a cause: with no counter moved at all the
 * answer says exactly that, which is a bug report rather than a reason and is spelled to read like
 * one.
 */
function whyNot(before: CoachCounters, after: CoachCounters): string {
  for (const reason of SKIP_REASONS) {
    if (after.skipped[reason] > before.skipped[reason]) return `skipped: ${reason}`;
  }
  if (after.failed > before.failed) return 'the model call failed — see the coach telemetry';
  if (after.discarded > before.discarded) {
    return 'the judgement was discarded: it named a signal it was not shown, or arrived too late';
  }
  return 'the coach answered nothing and moved no counter';
}

/** Narrowing helper for a proposal built by hand in a test. */
export function proposalOf(id: string, overrides: Partial<CoachProposal> = {}): CoachProposal {
  return {
    id: id as EventId,
    topic: { of: 'event', event: id as EventId },
    salience: 0.5,
    guidance: null,
    at: 0 as MonoMs,
    ...overrides,
  };
}

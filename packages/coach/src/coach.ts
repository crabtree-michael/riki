/**
 * The coach: the one stateful object in the package, and the only thing that subscribes.
 *
 * It is `EventEngine`'s opposite number and it is deliberately much smaller, because most of what
 * that file does is decide things this one does not decide. Compare the two ticks:
 *
 * ```
 *   EventEngine       version bump ──► detect ──► score ──► reconcile latches ──► thirteen gates
 *                                                                              ──► speak | reason
 *
 *   LlmCoach          version bump ──► detect ──► anything new? ──► should we ask? ──► narrate
 *                                                                      ──► one model call
 *                                                                      ──► speak | reasoning
 * ```
 *
 * ## The trigger is a detector event, and it is push-only
 *
 * **There is one arm and it is a thing that happened.** There is no timer in this file and no
 * consultation at match start; both existed in an earlier draft and both were cut to the same rule —
 * a stimulus exists because a detector fired, so a consultation with an empty `signals` is a
 * question with nothing to attribute an answer to (`types.ts`, `CoachJudgement.about`). A periodic
 * look at the game is the obvious next feature and it is deferred rather than forgotten; what it
 * needs first is somewhere for an unattributed utterance to be filed, which is an ADR-0013 question
 * and not a scheduling one.
 *
 * A version bump on its own is not the trigger — the world model bumps several times a second under
 * GSI and almost none of those bumps mean anything. The trigger is a **detector reporting a
 * condition that was not true at the last consultation**, which is exactly `CoachSignal.fresh`. That
 * makes a quiet game cost nothing rather than one request every `minConsultGapSeconds`, and it is
 * why `signals.read` happens in `onVersion` rather than inside `consult`.
 *
 * The freshness map is only advanced once the model has actually been shown the signals
 * (`signals.commit`), so a detection that arrives while Riki is muted is still new when the mute
 * lifts. A trigger that is skipped is deferred, not spent.
 *
 * ## What "should we ask?" is, and what it is not
 *
 * Requirement 2 puts the decision to speak with the model, so nothing here is a gate. What is left
 * is five conditions under which there is no point *asking*, and it is worth being precise about
 * why each survives — the temptation with a rule like requirement 2 is to remove all of them and
 * ship a coach that talks over the player.
 *
 * | Skip | Why it is not a policy |
 * |---|---|
 * | `quiet_mode`, `muted` | The player's own off switches. dota2 §6.4 requires them to work with the model unreachable, which they cannot do if the model is what honours them |
 * | `agent_speaking` | One audio channel. The composition root holds one turn slot for the same reason |
 * | `player_speaking` | Same channel, other direction |
 * | `in_flight` | One consultation at a time. Requirement 4 removed the latency budget, not causality — two overlapping judgements would each be reasoning about a world the other is about to change |
 * | `no_world` | There is nothing to narrate. Asking would be asking about an empty string |
 *
 * Everything else `packages/events` refuses for — a cooldown, a latch, novelty, intensity, a
 * salience floor — is gone, and the model is handed the facts those rules were computed from
 * instead. That is the trade, and `record.ts` and `signals.ts` are what make it a fair one.
 *
 * ## The two rate limits, which are on asking rather than on speaking
 *
 * Neither is a cooldown on speech — that decision is the model's (requirement 2). They bound how
 * often it is *asked*:
 *
 * - **A fresh detection is required** on the event path, so a game in which nothing new is true
 *   makes no requests on it at all.
 * - **`minConsultGapSeconds`** catches the other case: a teamfight in which six conditions become
 *   true in two seconds is one consultation, not six.

 * ## The soft deadline, which is not a timeout
 *
 * Nothing here cancels a model call. The deadline is **derived from the detectors** — the tightest
 * `actWithinSeconds` among the signals in the stimulus, floored at `minDeadlineSeconds` — and it is
 * read once, when the answer arrives. Its only effect is that a *late* judgement is checked against
 * the world before it is spoken: if the exact condition the model named has since stopped being
 * true, the line is dropped as overtaken; otherwise it is spoken, late. The default direction is to
 * speak, which is what separates this from a timeout — see `config.ts` for the full argument, and
 * `deadlineOf` for why the tightest window wins.
 *
 * See docs/design/llm-coach-architecture.md §4.5.
 */

import type { DetectionKey, EventDetector, TriggerConfig } from '@riki/events';
import { DEFAULT_TRIGGER_CONFIG, defaultDetectors } from '@riki/events';
import type { MonoMs, WorldSnapshot } from '@riki/world-model';
import type { LlmCoachConfig } from './config.js';
import { DEFAULT_COACH_CONFIG } from './config.js';
import type { CoachRecord, LlmCoach, LlmCoachDeps } from './contracts.js';
import { createCoachRecord } from './record.js';
import type { SignalReader } from './signals.js';
import { createSignalReader } from './signals.js';
import type {
  CoachCounters,
  CoachSignal,
  CoachStimulus,
  CoachUtterance,
  SkipReason,
  Unsubscribe,
} from './types.js';
import { SKIP_REASONS } from './types.js';

const MS_PER_SECOND = 1_000;

function zeroSkips(): Record<SkipReason, number> {
  const skipped = {} as Record<SkipReason, number>;
  for (const reason of SKIP_REASONS) skipped[reason] = 0;
  return skipped;
}

/**
 * The world as one consultation sees it, read once at the trigger and carried through.
 *
 * `onVersion` has to detect *before* it can decide whether to ask at all, so re-detecting inside
 * `consult` would run the eight detectors twice per trigger and — worse — against a snapshot taken a
 * moment later than the one that justified the request.
 */
interface Prepared {
  readonly snapshot: WorldSnapshot;
  readonly signals: readonly CoachSignal[];
}

export function createLlmCoach(deps: LlmCoachDeps): LlmCoach {
  const config: LlmCoachConfig = deps.config ?? DEFAULT_COACH_CONFIG;
  const detectors: readonly EventDetector[] = deps.detectors ?? defaultDetectors();
  const triggerConfig: TriggerConfig = deps.triggerConfig ?? DEFAULT_TRIGGER_CONFIG;
  const record: CoachRecord = deps.record ?? createCoachRecord();
  const signals: SignalReader = createSignalReader({ detectors, config: triggerConfig });

  const utteranceListeners = new Set<(utterance: CoachUtterance) => void>();
  const declinedListeners = new Set<(reason: string) => void>();

  let agentSpeaking = false;
  let playerSpeaking = false;
  let quietMode = false;
  let mutedUntil: MonoMs | null = null;

  let inFlight = false;
  let lastConsultAt: MonoMs | null = null;
  let seq = 0;

  let skips = zeroSkips();
  let consulted = 0;
  let spoke = 0;
  let declined = 0;
  let failed = 0;
  let discarded = 0;

  let unsubscribe: Unsubscribe | null = null;
  let disposed = false;
  /** See the call site after the model `await`: this exists to defeat control-flow narrowing. */
  const isDisposed = (): boolean => disposed;

  function count(reason: SkipReason): void {
    skips[reason] += 1;
    deps.telemetry?.skipped(reason);
  }

  /**
   * The soft deadline for one stimulus, in seconds, or null when no signal declares one.
   *
   * The **tightest** window among the signals, floored at `minDeadlineSeconds`. Tightest because a
   * stimulus carrying both `low_hp_no_escape` (five seconds) and `stack_now` (a minute) is a moment
   * where the five-second advice is the one that goes stale, and a deadline derived from the minute
   * would let it arrive after the player was already dead. Floored because a detector is free to
   * declare a window no round trip could meet, and a guaranteed-late request is worse than a fair
   * one — `config.ts` carries that argument.
   *
   * Null when every signal says `actWithinSeconds: null`, which is honest rather than defensive:
   * `enemy_missing` and `enemy_core_dead_window` describe an opportunity opening, not a deadline,
   * and inventing one for them would re-introduce the urgency-curve mistake the `agent-context`
   * skill records.
   */
  function deadlineOf(signals: readonly CoachSignal[]): number | null {
    const declared = signals
      .map((signal) => signal.actWithinSeconds)
      .filter((seconds): seconds is number => seconds !== null);
    if (declared.length === 0) return null;
    return Math.max(config.minDeadlineSeconds, Math.min(...declared));
  }

  /**
   * The player's controls and the physical ones, in that order.
   *
   * Ordered so the counter attributes a skip to the *most meaningful* reason: a muted Riki that is
   * also mid-utterance should read as muted, because that is what somebody reading the counters is
   * trying to find out. The same argument orders `packages/events`' ladder, and it is the only
   * thing this function has in common with it.
   */
  function skipReason(now: MonoMs): SkipReason | null {
    if (quietMode) return 'quiet_mode';
    if (mutedUntil !== null && now < mutedUntil) return 'muted';
    if (agentSpeaking) return 'agent_speaking';
    if (playerSpeaking) return 'player_speaking';
    if (inFlight) return 'in_flight';
    return null;
  }

  /**
   * Is the condition the model named still true?
   *
   * A fresh detector pass rather than a cached one: the whole question is whether the world moved
   * while the model was thinking, so the answer has to come from the world as it is now.
   *
   * It reads through `signals.read`, which is `SignalReader`'s non-committing accessor — the freshness
   * map must not advance on a check that is not a consultation, or the *next* stimulus would describe
   * a brand-new condition as one the coach had already been shown.
   */
  function stillTrue(key: DetectionKey, now: MonoMs): boolean {
    const current = signals.read(deps.world.snapshot(now), Number.MAX_SAFE_INTEGER);
    // By key, not by kind. `enemy_missing:sf` and `enemy_missing:puck` are the same kind and
    // different conditions, and a late line about the first must not be kept alive by the second
    // still being true — which is the entire reason `DetectionKey` exists (`packages/events` §5.3).
    return current.some((signal) => signal.key === key);
  }

  function decline(reasoning: string): void {
    declined += 1;
    deps.telemetry?.declined(reasoning);
    for (const listener of [...declinedListeners]) listener(reasoning);
  }

  async function consult(now: MonoMs, prepared?: Prepared): Promise<CoachUtterance | null> {
    if (disposed) return null;

    const skip = skipReason(now);
    if (skip !== null) {
      count(skip);
      return null;
    }

    const world = deps.narrator.narrate(now);
    if (world === '') {
      count('no_world');
      return null;
    }

    // `onVersion` has already detected in order to decide whether to ask at all, so its read is
    // passed through rather than repeated. A direct `consult` — the test and replay affordance —
    // has done no such thing and reads here.
    const { snapshot, signals: observed } = prepared ?? {
      snapshot: deps.world.snapshot(now),
      signals: signals.read(deps.world.snapshot(now), config.maxSignals),
    };

    // `CoachStimulus.signals` is specified never to be empty: a consultation exists because a
    // detector fired, and an answer has to have something to be attributed to. A direct `consult`
    // against a world where nothing is true is therefore not a consultation at all.
    if (observed.length === 0) {
      count('no_world');
      return null;
    }

    const last = record.lastSpokeAt();

    seq += 1;
    const stimulus: CoachStimulus = {
      seq,
      at: now,
      clock: snapshot.clock,
      world,
      signals: observed,
      spoken: record.recent(config.spokenHistoryDepth),
      secondsSinceSpoke: last === null ? null : (now - last) / MS_PER_SECOND,
      actWithinSeconds: deadlineOf(observed),
    };

    consulted += 1;
    deps.telemetry?.consulted(seq, observed.length);
    lastConsultAt = now;
    inFlight = true;

    let judgement;
    try {
      judgement = await deps.model.judge(stimulus);
    } finally {
      // Before anything else can await: a consultation that leaves this flag set stops the coach
      // for the rest of the match, and a rejection here is the one path that could.
      inFlight = false;
    }

    // The `fresh` flag is spent only once the model has actually been shown the signals. A
    // consultation that was skipped, or one whose model call failed, must not quietly turn a new
    // condition into an old one — the next consultation is the first that ever sees it.
    signals.commit();

    // Read through a function, deliberately. `disposed` is narrowed to `false` by the guard at the
    // top of `consult`, and TypeScript's control-flow analysis does not invalidate that across an
    // `await` — so a direct `if (disposed)` here is reported as always-falsy and is the one check
    // in this file that most needs to survive: a match torn down mid-consultation must not emit an
    // utterance into a disposed coaching root.
    if (isDisposed()) return null;

    if (judgement === null) {
      failed += 1;
      // Counted separately from `declined`: "the model said no" and "we could not ask" are
      // different facts, and a coach that goes quiet because of a bad key must not look like one
      // exercising judgement (`coaching-trigger-architecture.md` §5.4's argument, one layer up).
      return null;
    }

    if (!judgement.speak || judgement.say === null) {
      decline(judgement.reasoning);
      return null;
    }

    // **The ADR-0013 invariant, and the one thing in this design a model is not trusted with.**
    //
    // The model names *which of the signals it was shown* it is speaking about, and the signal it
    // named is what supplies `kind`, `key` and `topic` below. A key the stimulus did not contain is
    // discarded rather than repaired: there is nothing to attribute the utterance to, and inventing
    // an attribution is exactly how `agent_said.topics` would become free text with a struct around
    // it. Nothing is retried — `openai-model.ts` says why — and the same conditions will be offered
    // again on the next fresh detection, which costs one moment against a coaching record nobody
    // can trust.
    const named =
      judgement.about === null
        ? undefined
        : observed.find((signal) => signal.key === judgement.about);
    if (named === undefined) {
      discarded += 1;
      decline(
        judgement.about === null
          ? 'discarded: spoke without naming a signal'
          : `discarded: named a signal that was not in the stimulus`,
      );
      return null;
    }

    if (judgement.say.length > config.maxSayChars) {
      // Discarded rather than truncated: half a sentence spoken aloud is worse than silence
      // (`config.ts`, `maxSayChars`).
      discarded += 1;
      decline('discarded: the line was longer than maxSayChars');
      return null;
    }

    // The soft deadline, and the only other thing this package discards on its own account.
    //
    // Read once, here, rather than enforced by a timer: nothing was cancelled and the model was
    // never rushed. Inside the deadline the answer is spoken as judged. Past it, the one question
    // worth asking is whether the world moved *underneath the specific condition it named* — which
    // is answerable, because `about` is a `DetectionKey` and a detector can be asked whether that
    // exact condition is still true.
    //
    // A late line about a hero who has reappeared is wrong rather than stale; a late line about a
    // fight still happening is merely late, and silence is worse than late. So the default
    // direction is to speak, and a stimulus that declared no deadline is never late at all.
    const answeredAt = deps.clock.now();
    const deadline = stimulus.actWithinSeconds;
    if (deadline !== null && answeredAt - now > deadline * MS_PER_SECOND) {
      if (!stillTrue(named.key, answeredAt)) {
        discarded += 1;
        decline(`overtaken: ${named.key} was no longer true when the judgement arrived`);
        return null;
      }
    }

    const utterance: CoachUtterance = {
      // The detector's, all three. The model supplied none of them.
      kind: named.kind,
      key: named.key,
      topic: named.topic,
      weight: judgement.weight,
      say: judgement.say,
      reasoning: judgement.reasoning,
      at: now,
    };

    record.note(utterance, snapshot.clock);
    spoke += 1;
    deps.telemetry?.spoke(utterance.kind, utterance.weight, utterance.say.length);
    for (const listener of [...utteranceListeners]) listener(utterance);
    return utterance;
  }

  /**
   * A version bump, which is **not** on its own a reason to ask.
   *
   * The world model bumps several times a second under GSI and almost none of those bumps mean
   * anything. Two things have to be true before a request is made, in this order because the first
   * is a subtraction and the second runs eight detectors:
   *
   * 1. `minConsultGapSeconds` has passed — a teamfight in which six conditions become true in two
   *    seconds is one consultation, not six.
   * 2. At least one detection is **fresh**: a condition that was not true at the last consultation.
   *    A condition that is merely *still* true is not an event, which is what stops one missing hero
   *    from producing a request every two seconds for as long as they stay missing.
   *
   * Detection is pure, so step 2 is cheap enough to run per bump — `packages/events` does exactly
   * that. What is not cheap is the network call behind it, which is why the freshness test is here
   * rather than left to the model.
   *
   * A game in which nothing new happens therefore makes **no** requests at all.
   */
  function onVersion(): void {
    if (disposed) return;
    const now = deps.clock.now();
    if (
      lastConsultAt !== null &&
      now - lastConsultAt < config.minConsultGapSeconds * MS_PER_SECOND
    ) {
      return;
    }
    const snapshot = deps.world.snapshot(now);
    const observed = signals.read(snapshot, config.maxSignals);
    if (!observed.some((signal) => signal.fresh)) return;
    void consult(now, { snapshot, signals: observed });
  }

  return {
    start(): Unsubscribe {
      if (disposed) return (): void => undefined;
      unsubscribe?.();
      unsubscribe = deps.world.onVersion(onVersion);
      // **No consultation on start.** There used to be one, so the coach had seen the draft before
      // the first event arrived — it was cut with the tick, and by the same rule: a stimulus exists
      // because a detector fired, and one built at match start has an empty `signals` and therefore
      // nothing an answer could be attributed to. The draft still reaches the model, in the world
      // narration of the first real consultation.
      return (): void => {
        unsubscribe?.();
        unsubscribe = null;
      };
    },

    onUtterance(listener): Unsubscribe {
      utteranceListeners.add(listener);
      return () => utteranceListeners.delete(listener);
    },

    onDeclined(listener): Unsubscribe {
      declinedListeners.add(listener);
      return () => declinedListeners.delete(listener);
    },

    counters(): CoachCounters {
      return {
        consulted,
        skipped: { ...skips },
        spoke,
        declined,
        failed,
        discarded,
      };
    },

    setAgentSpeaking(speaking: boolean): void {
      agentSpeaking = speaking;
    },
    setPlayerSpeaking(speaking: boolean): void {
      playerSpeaking = speaking;
    },
    setQuietMode(on: boolean): void {
      quietMode = on;
    },
    setMuted(until: MonoMs | null): void {
      mutedUntil = until;
    },

    consult,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      utteranceListeners.clear();
      declinedListeners.clear();
      signals.clear();
      record.clear();
      skips = zeroSkips();
      consulted = 0;
      spoke = 0;
      declined = 0;
      failed = 0;
      discarded = 0;
      // Not awaited: `dispose` is synchronous because `EventEngine.dispose` is, and the composition
      // root's match teardown calls one or the other without knowing which. The provider's close is
      // releasing a pooled transport, not flushing anything we would lose.
      void deps.model.close();
    },
  };
}

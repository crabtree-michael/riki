/**
 * This package's vocabulary: what the model is asked, and what it answers.
 *
 * The shape of this file is the difference between the two coaches. `packages/events` keeps
 * *detection*, *salience* and *the gates* as three separate types because three separate parties
 * answer them — a detector says what is true, a scorer says how much it matters, and thirteen gates
 * say whether to speak anyway. Here **one party answers all three**, so there is one input type and
 * one output type, and the reasoning that produced the answer is a string rather than a number.
 *
 * That is the whole trade. `packages/events` can be tuned against a fixture corpus without a
 * network because every step is a pure function of a snapshot; this cannot, and in exchange it can
 * weigh a moment against the rest of the game rather than against a threshold.
 *
 * Declarations only. See docs/design/llm-coach-architecture.md §2.
 */

import type { AdviceTopic, EventId } from '@riki/context';
import type { CoachEventKind, DetectionKey } from '@riki/events';
import type { GameClock, MonoMs } from '@riki/world-model';

/** Every subscription in this package returns its own disposer. */
export type Unsubscribe = () => void;

// -----------------------------------------------------------------------------------------------
// What the coach is shown (§2.1)
// -----------------------------------------------------------------------------------------------

/**
 * One condition currently true, from `packages/events`' detectors.
 *
 * The **detectors** are shared with the deterministic coach; the salience scorer and the gates are
 * not, which is the precise line the design draws: the same underlying world-model events are the
 * triggers, and what happens after them is the model's judgement instead of a ladder.
 *
 * `salience` is deliberately absent. Handing the model a number that already encodes "how much this
 * matters" would be asking it to ratify a decision `packages/events` had already made — and the
 * whole point of this coach is that it makes that decision itself. `magnitude` and `confidence` are
 * facts about the detection; a weighted product of them is a policy.
 *
 * `kind` and `topic` ride along **unread by the model**. They are what the composition root needs to
 * open a turn once the model has named this signal, and carrying them here is what keeps ADR-0013's
 * closed topic vocabulary intact across a seam with a language model in the middle of it: the topic
 * that reaches `agent_said.topics` is the detector's own, byte for byte, and no path through this
 * package can synthesise one.
 */
export interface CoachSignal {
  readonly kind: CoachEventKind;
  /** The identity a judgement answers with. `enemy_missing:sf`, not `enemy_missing`. */
  readonly key: DetectionKey;
  /** The detector's, imported rather than derived. ADR-0013: one vocabulary, one origin. */
  readonly topic: AdviceTopic;
  /** Already natural language, from the detector. The model reads this, not the fields. */
  readonly text: string;
  /** 0..1. How big *this* instance of this kind is. */
  readonly magnitude: number;
  /** The minimum confidence of the facts behind it. */
  readonly confidence: number;
  /** Seconds for which the advice stays actionable, or null when there is no deadline. */
  readonly actWithinSeconds: number | null;
  /**
   * True the first time this exact condition appears since the last consultation.
   *
   * Not a latch and not a cooldown: it is a *fact about the world* — this is new — offered to a
   * model that is free to decide a long-standing condition has become worth mentioning anyway.
   * `packages/events`' `latched` gate makes that decision for it and cannot be talked out of it.
   *
   * It is also **what wakes the coach at all** (§4.5). A version bump that turns up no fresh signal
   * is not a consultation, and that is the whole of the push-only cadence.
   */
  readonly fresh: boolean;
}

/** Something the coach has already said this match. Its own record, not the conversation ledger. */
export interface SpokenNote {
  readonly atClock: GameClock | null;
  readonly at: MonoMs;
  readonly text: string;
  readonly kind: CoachEventKind;
}

/**
 * One consultation's worth of input.
 *
 * Everything the model is given, and it is given all of it every time: there is no conversation
 * history across consultations. Each judgement is a fresh call whose entire context is this object,
 * which is what keeps a forty-minute match from turning into a forty-minute prompt — and it is why
 * `spoken` exists as a field rather than as prior turns.
 *
 * **`signals` is never empty.** A consultation exists because a detector fired, so there is always
 * at least one condition to attribute an answer to (§4.5).
 */
export interface CoachStimulus {
  /** Monotonic per match, so telemetry can tell a dropped consultation from a quiet one. */
  readonly seq: number;
  readonly at: MonoMs;
  readonly clock: GameClock | null;
  /**
   * The world, as `packages/context` renders it for the Realtime model — ages, confidences and all.
   *
   * The same renderer, deliberately. A second view of the world written for this coach would be a
   * second place for the "never render a stale fact as a bare fact" rule to be got wrong, and the
   * golden corpus only covers one of them.
   */
  readonly world: string;
  readonly signals: readonly CoachSignal[];
  /** Newest last. What the coach has said this match, capped by `spokenHistoryDepth`. */
  readonly spoken: readonly SpokenNote[];
  /** Seconds since Riki last spoke, or null if it has not, this match. */
  readonly secondsSinceSpoke: number | null;
  /**
   * The soft deadline, in seconds, or null when no signal here declares one (§4.6).
   *
   * Rendered into the prompt as well as enforced, and showing it is the point: a model that knows it
   * has five seconds can skip the library lookup and answer, where one that does not will spend the
   * window on a tool call and have its answer thrown away.
   */
  readonly actWithinSeconds: number | null;
}

// -----------------------------------------------------------------------------------------------
// What the coach answers (§2.2)
// -----------------------------------------------------------------------------------------------

/**
 * The judgement. **`speak: false` is the expected answer** and the instructions say so.
 *
 * `reasoning` is recorded either way, and that is the tuning signal this coach has instead of
 * `packages/events`' per-gate refusal counters. It is the answer to "why is Riki quiet", which
 * under a proactive product is the question that decides whether anyone keeps the feature on
 * (coaching-trigger-architecture.md §5.4). Losing that signal was the main cost of dropping the
 * gates and this field is what buys it back.
 */
export interface CoachJudgement {
  readonly speak: boolean;
  /** One or two sentences, why. Recorded whether or not it spoke; never sent to the player. */
  readonly reasoning: string;
  /**
   * What to say, already speakable. Null when `speak` is false.
   *
   * The Realtime model voices this in Riki's persona rather than reading it out — the persona lives
   * in the session preamble and this coach does not have it (voice-input §5.2).
   */
  readonly say: string | null;
  /**
   * **Which signal this is about, by key, and it must be one the stimulus listed.**
   *
   * This is the one thing in the design a model is not trusted with, and the reason is ADR-0013: a
   * topic is a closed union with one origin, and `agent_said.topics` is built from it. A model free
   * to name its own subject would make the coaching record free text with a struct around it, and
   * the novelty gate would be reading values no detector ever produced.
   *
   * So the model chooses *which of the moments it was shown* it is speaking about, `coach.ts`
   * resolves that key back to the `CoachSignal` it sent, and the topic comes off the detector
   * exactly as it does on the static path. A key the stimulus did not contain is a discarded
   * judgement, not a repaired one — `openai-model.ts` says why nothing is retried.
   *
   * Null when `speak` is false, where there is nothing to attribute.
   */
  readonly about: DetectionKey | null;
  /**
   * 0..1, the model's own view of how much this mattered.
   *
   * It occupies `CoachEvent.salience`'s slot in the ledger and in telemetry so the two coaches are
   * comparable in the record, and it is **not** compared against a threshold anywhere: the model
   * already decided by setting `speak`. A number that both reports and decides is the conflation
   * `packages/events` keeps cooldowns out of salience to avoid.
   */
  readonly weight: number;
}

// -----------------------------------------------------------------------------------------------
// What the coach emits (§2.3)
// -----------------------------------------------------------------------------------------------

/**
 * A judgement that said yes, resolved back against the signal it named.
 *
 * `kind`, `key` and `topic` are the detector's; `weight`, `say` and `reasoning` are the model's. That
 * split is the whole contract: **the model decides whether and what, the detector decides what it is
 * filed under.** Structurally this is the three fields `CoachEvent` carries across the same seam plus
 * the one thing the deterministic coach has no equivalent for, which is what makes the toggle a
 * toggle — the composition root's `CoachDriver` takes either, and neither package knows the other
 * exists.
 */
export interface CoachUtterance {
  /** From the named `CoachSignal`. `EventId` is the same string; `eventIdOf` is where it is cast. */
  readonly kind: CoachEventKind;
  readonly key: DetectionKey;
  readonly topic: AdviceTopic;
  readonly weight: number;
  /** Non-empty by construction: an utterance with nothing to say is a judgement of `speak: false`. */
  readonly say: string;
  readonly reasoning: string;
  readonly at: MonoMs;
}

/**
 * The one place in this package a `CoachEventKind` is asserted to be a `packages/context` `EventId`.
 *
 * The two unions hold the same eight strings and are declared in two packages so that neither has to
 * wait for the other to compile (coaching-architecture.md §4.4). `packages/events` makes the same
 * assertion inside `eventTopic`; this is the second, and there should not be a third.
 */
export function eventIdOf(kind: CoachEventKind): EventId {
  return kind as EventId;
}

// -----------------------------------------------------------------------------------------------
// Why a consultation did not happen (§4.3)
// -----------------------------------------------------------------------------------------------

/**
 * Six, and **none of them is a gate**.
 *
 * The distinction is the load-bearing one in this design and it is worth being exact about, because
 * "the LLM decides for itself when to speak" does not mean "the LLM can talk over the player". Two
 * of these are the player's own controls, which must keep working with the model down; three are
 * mechanical — there is one audio channel and one in-flight request; one is a missing input.
 *
 * What is deliberately **absent** is every policy arm of `SuppressionReason`: `latched`,
 * `kind_cooldown`, `global_cooldown`, `already_advised`, `ignored_twice`, `stale_window`,
 * `below_threshold`, `high_intensity` and the rest of the thirteen. Each of those is a judgement
 * about whether a thing is worth saying, and each is now the model's to make. They are still in
 * `packages/events`, intact, for the coach that owns them.
 *
 * **Nothing may be added to this list without an ADR.** A seventh reason is a gate wearing a
 * mechanical hat, and the two failure modes it produces — a coach that is quiet for a reason nobody
 * chose, and a design that drifts back to the ladder one skip at a time — are exactly what this
 * coach exists to avoid.
 */
export type SkipReason =
  /** "Only when I ask." The off switch, and it must work when the model is unreachable. */
  | 'quiet_mode'
  | 'muted'
  /** A turn is already open. One audio channel, so this is physics rather than policy. */
  | 'agent_speaking'
  | 'player_speaking'
  /** A consultation is outstanding. One judgement at a time — §4.5 on why this is not a budget. */
  | 'in_flight'
  /** The narrator rendered nothing — no match, or a world with no facts in it yet. */
  | 'no_world';

export const SKIP_REASONS: readonly SkipReason[] = [
  'quiet_mode',
  'muted',
  'agent_speaking',
  'player_speaking',
  'in_flight',
  'no_world',
];

/** Per-reason skips, plus the shape of what the model said. The tuning surface (§7). */
export interface CoachCounters {
  /** Consultations actually put to the model. There is one cause, so this is a number. */
  readonly consulted: number;
  readonly skipped: Readonly<Record<SkipReason, number>>;
  readonly spoke: number;
  readonly declined: number;
  /** A model call that threw or returned nothing usable. Non-zero is a condition, not a bug. */
  readonly failed: number;
  /**
   * An answer that arrived after its window closed, or that named a signal it was not shown.
   *
   * Both are *discarded judgements* rather than failures — the model answered, and the answer was
   * not usable. A rising count is the signal to look at the model tier (§8) or at the prompt.
   */
  readonly discarded: number;
}

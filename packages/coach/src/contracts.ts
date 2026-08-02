/**
 * The seams: narrate, judge, remember, count — plus the coach that runs them.
 *
 * Only one of the four can reach a network, and confining it to `CoachModel` is what makes the rest
 * of this package a Tier 1 test with no key and no session (REPO_SKELETON.md §5.2). `coach.test.ts`
 * drives a whole match through `FakeCoachModel` and asserts every decision this package makes on
 * its own — which stimuli are built, which consultations are skipped, what the record says
 * afterwards. The only thing it cannot assert is the judgement itself, and that is the honest
 * boundary of what is testable here.
 *
 * Declarations only. See docs/design/llm-coach-architecture.md §4.
 */

import type { EventDetector, TriggerConfig } from '@riki/events';
import type { Clock, GameClock, MonoMs, WorldModelReader } from '@riki/world-model';
import type { LlmCoachConfig } from './config.js';
import type {
  CoachCounters,
  CoachJudgement,
  CoachStimulus,
  CoachUtterance,
  SkipReason,
  SpokenNote,
  Unsubscribe,
} from './types.js';

// -----------------------------------------------------------------------------------------------
// Narration (§4.1)
// -----------------------------------------------------------------------------------------------

/**
 * The world, as text the model can read.
 *
 * A port and not an import, because the thing that satisfies it is `packages/context`'s snapshot
 * renderer wired to `packages/world-model` through the composition root's own projection table —
 * two packages and an adapter that this one has no business assembling. It also means the whole of
 * this package's logic can be tested by handing it a string.
 *
 * **Empty means "nothing worth narrating"**, not "narration failed". Total, like every other
 * renderer in the repo: a world with no facts in it yet renders nothing and the consultation is
 * skipped `no_world`, which is the correct behaviour before the horn.
 */
export interface WorldNarrator {
  narrate(now: MonoMs): string;
}

// -----------------------------------------------------------------------------------------------
// Judgement (§4.2)
// -----------------------------------------------------------------------------------------------

/**
 * The one thing here that reaches OpenAI. Everything else in this package is a pure function or a
 * subscription.
 *
 * **It resolves to `null` rather than rejecting.** A model call that failed, timed out, returned
 * malformed output or ran out of tool turns is *silence*, which is the same thing this product does
 * a hundred times a match anyway and is not worth an exception on the path that decides whether to
 * talk to a player mid-fight. The counter is the record (`CoachCounters.failed`), and a rising one
 * means the key, the model id or the network — never a bug in the caller.
 */
export interface CoachModel {
  judge(stimulus: CoachStimulus): Promise<CoachJudgement | null>;
  /** Releases any pooled transport. Safe to call twice. */
  close(): Promise<void>;
}

// -----------------------------------------------------------------------------------------------
// The coach's own memory (§4.4)
// -----------------------------------------------------------------------------------------------

/**
 * What the coach has said, this match.
 *
 * Deliberately **not** the conversation ledger. The ledger is the record of what the *session* was
 * told and is projected on every novelty-gate read (ADR-0012); this is a short ring the coach reads
 * back to itself so it can decline to repeat something. It holds the coach's own words, which the
 * ledger only learns later and only as a transcript.
 *
 * It is not a novelty gate either. Nothing here refuses anything — it is an *input* to a judgement,
 * and the model is free to say the same thing twice if the second time is warranted.
 */
export interface CoachRecord {
  note(utterance: CoachUtterance, clock: GameClock | null): void;
  /** Newest last, capped. */
  recent(n: number): readonly SpokenNote[];
  lastSpokeAt(): MonoMs | null;
  clear(): void;
}

// -----------------------------------------------------------------------------------------------
// Telemetry (§7)
// -----------------------------------------------------------------------------------------------

/**
 * `console.*` is confined to `packages/telemetry`, so this is a port.
 *
 * `declined` carries the model's reasoning and `spoke` does not carry what was said. That asymmetry
 * is deliberate: the reasoning behind a *silence* is the tuning signal this coach has instead of
 * thirteen counters, and it is about the game rather than about the player — while an utterance is
 * a transcript, and a transcript in a log is a privacy surface (`ShellTelemetry`'s header).
 */
export interface CoachTelemetry {
  consulted(seq: number, signals: number): void;
  spoke(kind: string, weight: number, chars: number): void;
  declined(reasoning: string): void;
  skipped(reason: SkipReason): void;
  /** The message, never the key: `ApiKey` renders as `[redacted]` but an error string may not. */
  modelFailed(message: string): void;
}

// -----------------------------------------------------------------------------------------------
// The coach (§4.5)
// -----------------------------------------------------------------------------------------------

export interface LlmCoachDeps {
  readonly world: WorldModelReader;
  readonly narrator: WorldNarrator;
  readonly model: CoachModel;
  /** The composition root owns the one clock; `onVersion` carries a delta and no time. */
  readonly clock: Clock;
  // There is deliberately no `Timers` here. An earlier draft woke the coach on a cadence to inject
  // fresh state absent a detection; the decision is **push-only**, so the one thing that reaches
  // the model is a detector reporting a condition that was not true at the last consultation. A
  // timer port left declared-but-unused is an invitation to re-add the tick without re-deciding it,
  // which is why it is gone rather than optional.
  readonly config?: LlmCoachConfig;
  /** Defaults to `packages/events`' eight. Shared deliberately — requirement 3. */
  readonly detectors?: readonly EventDetector[];
  /** The detectors' own thresholds. Shared for the same reason. */
  readonly triggerConfig?: TriggerConfig;
  readonly record?: CoachRecord;
  readonly telemetry?: CoachTelemetry;
}

/**
 * The one stateful object in the package, and the only thing that subscribes to anything.
 *
 * The four setters are the same four `EventEngine` has, and they mean the same things — which is
 * what lets the composition root hold either behind one `CoachDriver` port. What differs is what
 * they *do*: `EventEngine` feeds them to gates 2 through 5, and this feeds two of them to a skip
 * and hands the model the rest as facts about the moment.
 */
export interface LlmCoach {
  /**
   * Subscribes to `onVersion` and consults once for `match_started`. Returns the disposer.
   *
   * No tick is armed — push-only. A quiet game makes no requests at all.
   */
  start(): Unsubscribe;

  /** At most one per consultation, and only when the model said yes. */
  onUtterance(listener: (utterance: CoachUtterance) => void): Unsubscribe;

  /**
   * A consultation that did not happen, or one that came back `speak: false`.
   *
   * The composition root records it the same way it records a suppression, which is what keeps
   * "Riki said nothing" distinguishable from "Riki noticed nothing" under either coach.
   */
  onDeclined(listener: (reason: string) => void): Unsubscribe;

  counters(): CoachCounters;

  setAgentSpeaking(speaking: boolean): void;
  setPlayerSpeaking(speaking: boolean): void;
  setQuietMode(on: boolean): void;
  /** `null` clears the mute. */
  setMuted(untilMs: MonoMs | null): void;

  /**
   * Consult now, against the world as it stands. Test and replay affordance.
   *
   * Async where `EventEngine.evaluate` is synchronous, and that is the whole difference between the
   * two coaches in one signature.
   */
  consult(now: MonoMs): Promise<CoachUtterance | null>;

  dispose(): void;
}

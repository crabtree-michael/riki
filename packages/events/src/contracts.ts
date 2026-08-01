/**
 * The four seams: detect, score, gate, tape — plus the engine that runs them.
 *
 * Every one of the first four is a **pure function**. That is not incidental tidiness: it is what
 * makes the whole trigger policy a Tier 1 test with no game, no session and no clock, which is the
 * only way the numbers in `config.ts` ever get tuned against a fixture corpus rather than against a
 * running match (coaching-trigger-architecture.md §13).
 *
 * Declarations only. See docs/design/coaching-trigger-architecture.md §3, §4, §5, §6, §8.
 */

import type { CoachingMemoryReader, TapeEvent } from '@riki/context';
import type { GameClock, MonoMs, WorldSnapshot } from '@riki/world-model';
import type { TriggerConfig } from './config.js';
import type {
  CoachEvent,
  CoachEventKind,
  Detection,
  DetectionKey,
  SuppressionReason,
  TriggerCounters,
  TriggerDecision,
  Unsubscribe,
} from './types.js';

// -----------------------------------------------------------------------------------------------
// Detection (§3)
// -----------------------------------------------------------------------------------------------

/**
 * One per `CoachEventKind`, and a pure function of the snapshot.
 *
 * **It reads a snapshot, not a delta**, and coaching-trigger-architecture.md §3.1 is the argument:
 * a delta shows an *edge*, and an edge is not the same as a condition being newly worth mentioning.
 * A hero who goes missing, is glimpsed on a ward for one frame and goes missing again produces two
 * edges and one situation. What turns "continuously true" into "said once" is the latch (§5.3), not
 * the detector.
 *
 * The delta is still what decides *when* this runs: the engine subscribes to `onVersion`, so
 * detection happens on change and never on a timer.
 */
export interface EventDetector {
  readonly kind: CoachEventKind;
  /** Total: a missing input yields no detections, never a guess and never a throw. */
  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[];
}

// -----------------------------------------------------------------------------------------------
// Salience (§4)
// -----------------------------------------------------------------------------------------------

/**
 * `kindWeight × magnitude × urgency × confidence × tendency`.
 *
 * Five factors, each owned by exactly one place. **Cooldowns are deliberately not among them**: a
 * cooldown folded into a score makes the threshold untunable, because one number would then mean
 * both "this is not important" and "this is important but I said it recently", and no single
 * threshold is correct for both (coaching-architecture.md §4.4).
 */
export interface SalienceScorer {
  score(detection: Detection, cfg: TriggerConfig): number;
}

/**
 * `PlayerMemory.adviceTendency` (ADR-0013), as a frozen lookup.
 *
 * A **preamble-time** read and not a per-turn one (coaching-architecture.md §6.2), which is why it
 * arrives as a resolved function rather than as a store: by the time the engine exists, the answer
 * has already been computed. The identity — `() => 1` — is what a first-ever match gets.
 */
export type TendencyIndex = (topic: Detection['topic']) => number;

// -----------------------------------------------------------------------------------------------
// The gates (§5)
// -----------------------------------------------------------------------------------------------

/**
 * Everything a gate may read. Assembled once per tick by the engine, then handed to pure functions.
 *
 * `memory` is nullable because a composition root may wire an engine before a match ledger exists.
 * A gate whose input is missing **refuses nothing** rather than refusing everything: the novelty
 * gate with no memory cannot know that something was already said, and silently suppressing all
 * coaching because the ledger was not wired is a far worse failure than one repeated tip.
 */
export interface GateContext {
  readonly world: WorldSnapshot;
  readonly now: MonoMs;
  readonly clock: GameClock | null;
  readonly memory: CoachingMemoryReader | null;
  readonly cfg: TriggerConfig;
  /** §7's score, 0..1. */
  readonly intensity: number;
  readonly agentSpeaking: boolean;
  readonly playerSpeaking: boolean;
  readonly quietMode: boolean;
  /** Monotonic instant the mute expires, or null when not muted. */
  readonly mutedUntil: MonoMs | null;
  /** When Riki last spoke, monotonic. Null when it has not, this match. */
  readonly lastSpokeAt: MonoMs | null;
  /** Per-kind, monotonic. The `kind_cooldown` input. */
  readonly lastSpokeByKind: ReadonlyMap<CoachEventKind, MonoMs>;
  /** Keys latched by a previous utterance and still continuously true (§5.3). */
  readonly latched: ReadonlySet<DetectionKey>;
}

/**
 * One reason, or null to pass. Pure, so the whole ladder is a table test.
 *
 * A gate returns its *own* reason and never another's, which is what makes the attribution in §5.2
 * rule 3 mechanical: the first gate in the ladder that refuses supplies the reason, and the
 * ordering of the ladder is therefore the policy.
 */
export interface Gate {
  readonly reason: SuppressionReason;
  refuses(candidate: CoachEvent, ctx: GateContext): boolean;
}

/**
 * Ranks the candidates and asks the gates about the winner.
 *
 * **It does not fall through to the runner-up** (§5.5). The gates that would refuse the winner are
 * mostly about *Riki* — speaking, muted, in a fight, on cooldown — not about the candidate, so a
 * fall-through would say something less useful for a reason that applies to it equally.
 */
export interface TriggerPolicy {
  decide(candidates: readonly CoachEvent[], ctx: GateContext): TriggerDecision;
}

// -----------------------------------------------------------------------------------------------
// The tape (§6)
// -----------------------------------------------------------------------------------------------

/**
 * The snapshot's `recent:` line, which `packages/context` reads through its own `EventTapeReader`
 * port — a port that package declares and this one implements, wired in the composition root
 * (context-and-memory §8.2). That inversion is what keeps `packages/context` free of any import of
 * `@riki/events` while the data flows the way dota2 §3's diagram says.
 *
 * **It records detections, not utterances.** A model shown only the things Riki already said has no
 * idea what it missed, so anything clearing `tapeSalience` is taped whether or not it was spoken.
 */
export interface EventTape {
  /** The last n, **top-`n` by salience** and then ordered newest last. §6 says why both. */
  recent(n: number, since: GameClock | null): readonly TapeEvent[];
  record(event: CoachEvent): void;
  clear(): void;
}

// -----------------------------------------------------------------------------------------------
// The engine (§8)
// -----------------------------------------------------------------------------------------------

/**
 * The one stateful object in the package, and the only thing that subscribes to anything.
 *
 * The four setters are the whole of its mutable input from outside the world model. They are
 * setters rather than a subscription because the composition root is the only writer, and because
 * a gate reading a stale "is the agent speaking" produces exactly the failure that gate exists to
 * prevent.
 */
export interface EventEngine {
  /**
   * Subscribes to `WorldModelReader.onVersion`. Separate from construction so a test can build an
   * engine, arrange the world, and then attach — which is what makes the gate ladder assertable
   * without a fake subscription.
   */
  start(): Unsubscribe;

  /** At most one per version bump, already gated. */
  onCoachEvent(listener: (event: CoachEvent) => void): Unsubscribe;

  /**
   * Every refusal, so the composition root can append the ledger's `turn_closed: 'silent'` entry.
   * Together with `counters()` this is what makes "Riki said nothing" distinguishable from "Riki
   * noticed nothing" (§5.4).
   */
  onSuppressed(
    listener: (reason: SuppressionReason, event: CoachEvent | null) => void,
  ): Unsubscribe;

  readonly tape: EventTape;
  counters(): TriggerCounters;

  setAgentSpeaking(speaking: boolean): void;
  setPlayerSpeaking(speaking: boolean): void;
  setQuietMode(on: boolean): void;
  /** `null` clears the mute. */
  setMuted(untilMs: MonoMs | null): void;

  /** Test and replay affordance: run one tick against the world as it stands, with no subscription. */
  evaluate(now: MonoMs): TriggerDecision;

  dispose(): void;
}

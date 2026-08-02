/**
 * What the coaching agent needs from the rest of the process, as ports.
 *
 * The composition root is the one place allowed to know about every package at once, and taking its
 * collaborators by injection rather than constructing them is what keeps that privilege from
 * turning into an untestable knot: every behaviour in `index.ts` is asserted against a fake session
 * and a hand-built world, with no Electron and no network.
 *
 * `CoachingSessionPort` is deliberately narrower than `@riki/realtime`'s `RealtimeSession`. The
 * agent needs to open a turn, speak, abort, and hear the vendor-free event stream; it has no
 * business reaching the transport, the window executor or the cost meter, and a port it cannot
 * reach is a coupling nobody has to remember not to add.
 *
 * See docs/design/coaching-trigger-architecture.md §9.
 */

import type { CoachMode } from '@riki/config';
import type { AdviceTopic, EventId, RikiContext, TurnId } from '@riki/context';
import type { CaptureMode, TurnEndReason, VoiceEvent } from '@riki/realtime';
import type { Clock, MonoMs, WorldModelReader } from '@riki/world-model';

/**
 * What the session is handed for a turn.
 *
 * `@riki/realtime`'s `TurnContext` is a structural mirror of `packages/context`'s, and it carries
 * one text field because that package puts the rendered text on the wire and never inspects it.
 * The snapshot and the brief are composed into that field here (`index.ts`) rather than sent as two
 * conversation items: two items cost two round trips through the same `response.create` and give
 * the model no more information than one.
 */
export interface SessionTurn {
  readonly turnId: TurnId;
  readonly snapshotText: string;
}

/** Why an unprompted turn exists. Carried for the ledger, not read by the session. */
export interface SpeakReason {
  readonly eventId: string;
  readonly salience: number;
}

// -----------------------------------------------------------------------------------------------
// The two coaches, behind one port
// -----------------------------------------------------------------------------------------------

/**
 * Which coach is running. Persisted, reported, and switchable while the app is up.
 *
 * Re-exported rather than redeclared: `CoachMode` is `@riki/config`'s, and two spellings of a
 * two-member union is two things that have to agree about what `llm` means. The *value* does not
 * come from that package — there is no `RIKI_COACH` — it comes from the tray, through
 * `settings.json` (ADR-0031 §4).
 */
export type { CoachMode };

/**
 * A moment worth speaking about, from whichever coach is switched on.
 *
 * The first three fields are `CoachEvent`'s, unchanged, because they are what everything downstream
 * of this file already reads: `id` keys `BRIEF_PLAN` and the snapshot's cause-driven promotion,
 * `topic` is what `agent_said.topics` records, and `salience` is what the ledger's `TurnCause`
 * carries. Neither coach translates them — `driver.ts` copies them.
 */
export interface CoachProposal {
  readonly id: EventId;
  readonly topic: AdviceTopic;
  /** The deterministic coach's salience, or the LLM coach's own `weight`. Same slot, same meaning. */
  readonly salience: number;
  /**
   * What to say, when the coach that produced this had an opinion about it. Null from
   * `packages/events`, where `BRIEF_PLAN` and the Realtime model decide the words between them.
   *
   * Non-empty when present: a coach with nothing to say does not propose.
   */
  readonly guidance: string | null;
  readonly at: MonoMs;
}

/**
 * The seam the toggle turns on, and the only thing `index.ts` knows about either coach.
 *
 * It is `EventEngine`'s shape minus everything the composition root never used — the tape, the
 * counters, `evaluate` — because the whole point is that this file cannot express a preference
 * between the two implementations. `driver.ts` holds both adapters and is the one place that
 * imports `@riki/events` and `@riki/coach` in the same scope.
 *
 * **The four setters mean the same thing under both coaches and do different things.** Under
 * `packages/events` they feed gates 2 through 5; under `packages/coach` two of them are honoured as
 * hard skips — they are the player's own controls and must work with the model unreachable — and
 * the rest is the model's judgement. `llm-coach-architecture.md` §4.3 is the table.
 */
export interface CoachDriver {
  readonly mode: CoachMode;
  /** Subscribes to whatever it needs. Returns the disposer. */
  start(): () => void;
  /** At most one open at a time; the composition root's single turn slot is what guarantees it. */
  onProposal(listener: (proposal: CoachProposal) => void): () => void;
  /**
   * A moment that did not become a turn.
   *
   * A `SuppressionReason` from the deterministic coach and a sentence from the LLM one. The
   * composition root records the *transition* rather than every instance (ADR-0024), so a string is
   * the right width here — the per-gate accounting stays in `engine.counters()` where it always was.
   */
  onDeclined(listener: (reason: string) => void): () => void;

  setAgentSpeaking(speaking: boolean): void;
  setPlayerSpeaking(speaking: boolean): void;
  setQuietMode(on: boolean): void;
  setMuted(untilMs: MonoMs | null): void;

  dispose(): void;
}

export interface CoachingSessionPort {
  /** The proactive path: no capture, no gesture, straight to a response. */
  speakUnprompted(turn: SessionTurn, reason: SpeakReason): Promise<void>;
  /** Push-to-talk. Synchronous, because nothing on the trigger path may await. */
  beginTurn(mode: CaptureMode, now: MonoMs): TurnId;
  endTurn(turnId: TurnId, reason: TurnEndReason, turn: SessionTurn): Promise<void>;
  /** `Esc`, or a local `stop`. */
  abort(): Promise<void>;
  onEvent(listener: (event: VoiceEvent) => void): () => void;
}

/**
 * `console.*` is confined to `packages/telemetry`, so this is a port. It carries no transcript and
 * no rendered text: what is interesting here is *counts*, and the golden corpus is where output is
 * inspected.
 */
export interface AgentTelemetry {
  /** The §5.4 tuning signal: how many moments were detected against how many were spoken. */
  coachingTurn(eventId: string, salience: number, spoke: boolean): void;
  suppressed(reason: string, eventId: string | null): void;
  /**
   * A brief that rendered nothing.
   *
   * Under the deterministic coach this is a silent turn and a rising count means `BRIEF_PLAN` is
   * wrong. Under the LLM coach it is **not** a reason for silence — the model has already read the
   * world and decided there is something to say — so the count means the same thing and has a
   * different consequence. `index.ts` is where the two diverge, and it is the only place they do.
   */
  emptyBrief(eventId: string): void;
  /** Which coach produced a turn. Without it the ledger cannot say, after the fact, which spoke. */
  coachMode?(mode: CoachMode): void;
}

export interface CoachingAgentDeps {
  readonly world: WorldModelReader;
  /** From `createContextAssembler`, already wired to the world view and the event tape. */
  readonly context: RikiContext;
  /** `staticCoachDriver(engine)` or `llmCoachDriver(coach)` — see `driver.ts`. */
  readonly driver: CoachDriver;
  readonly session: CoachingSessionPort;
  readonly clock: Clock;
  readonly telemetry?: AgentTelemetry;
}

export interface CoachingAgent {
  /** Subscribes to the engine and to the session. Returns the disposer for both. */
  start(): () => void;
  /**
   * A push-to-talk press. Synchronous and returns the turn id, because the overlay's ≤100 ms budget
   * forbids an `await` between the key press and the window being shown.
   */
  beginPlayerTurn(mode: CaptureMode): TurnId;
  /** The release. This is where a player turn's snapshot and brief are rendered and injected. */
  endPlayerTurn(turnId: TurnId, reason: TurnEndReason): Promise<void>;
  dispose(): void;
}

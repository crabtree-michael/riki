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

import type { RikiContext, TurnId } from '@riki/context';
import type { EventEngine } from '@riki/events';
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
  /** A brief that rendered nothing. Should be rare; a rising count means `BRIEF_PLAN` is wrong. */
  emptyBrief(eventId: string): void;
}

export interface CoachingAgentDeps {
  readonly world: WorldModelReader;
  /** From `createContextAssembler`, already wired to the world view and the event tape. */
  readonly context: RikiContext;
  readonly engine: EventEngine;
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

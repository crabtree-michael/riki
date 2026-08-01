/**
 * Turn-taking: a turn is a gesture, not a VAD event.
 *
 * Server VAD stays on with `create_response: false` (ADR-0017), so the server detects speech —
 * which is what keeps server-side barge-in truncation working on WebRTC — while nothing is ever
 * generated without our explicit `response.create`.
 *
 * The sharp edge that falls out of that: with VAD on, the input buffer is committed when the
 * server sees speech *stop*, so a `response.create` sent the instant the trigger is released can
 * race the tail of the utterance. `endTurn` waits for `speech_stopped`, bounded by
 * `commitGraceMs`. That wait is pure latency on every turn and is the cost of ADR-0017.
 *
 * See docs/design/voice-input-architecture.md §5.4, §5.5. Declarations only.
 */

import type { MonoMs, TurnId } from './types.js';

export type CaptureMode = 'push' | 'latch';

export type TurnEndReason = 'release' | 'latch-tap' | 'timeout' | 'cancel';

/**
 * ⚠ `packages/context`'s `TurnContext` and `SessionContext`, declared structurally: this package
 * puts the rendered text on the wire and never inspects it, so the two fields it needs are all it
 * mirrors. Replaced by an import at step 7.
 */
export interface TurnContext {
  readonly turnId: TurnId;
  readonly snapshotText: string;
}

/** Why an unprompted turn exists, from `packages/events`. Carried for the ledger, not read here. */
export interface UnpromptedBrief {
  readonly eventId: string;
  readonly salience: number;
}

export interface TurnConfig {
  /** Default 400. The bound on waiting for `speech_stopped` after the trigger is released. */
  readonly commitGraceMs: number;
  /** Default 8000, matching the overlay's listen timeout so the two cannot disagree. */
  readonly maxCaptureMs: number;
}

export interface TurnController {
  /**
   * Opens the gate. Synchronous, because nothing on the trigger path may await — the overlay's
   * ≤100 ms budget is spent on scheduling otherwise (overlay-architecture.md §9.1).
   */
  beginTurn(mode: CaptureMode, now: MonoMs): TurnId;

  /**
   * Closes the gate, waits for `speech_stopped` bounded by `commitGraceMs`, injects the turn's
   * snapshot as a conversation item, then creates the response — in that order, so the model
   * always sees the freshest possible state and always sees it before it is asked to speak.
   */
  endTurn(turnId: TurnId, reason: TurnEndReason, context: TurnContext): Promise<void>;

  /**
   * Barge-in. `at` is the moment the player interrupted, not the moment this ran.
   *
   * On WebRTC with VAD on, the server truncates and we only record what was heard — sending our
   * own truncate as well would truncate twice at two different offsets. On WebSocket, and on any
   * cancel where VAD never fired, we send `conversation.item.truncate` ourselves. That last case
   * is the one that is easy to miss and the one that corrupts the model's belief about what it
   * said (architecture §5.5).
   */
  interrupt(at: MonoMs): Promise<void>;

  /** `Esc`, or a local `stop`. Cancels the response *and* truncates what was already heard. */
  abort(): Promise<void>;

  /** The trigger policy's path: no capture, no gesture, straight to a response (dota2 §6.4). */
  speakUnprompted(context: TurnContext, brief: UnpromptedBrief): Promise<void>;
}

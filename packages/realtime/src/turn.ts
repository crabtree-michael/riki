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
 * See docs/design/voice-input-architecture.md §5.4, §5.5.
 */

import type { ItemId, MonoMs, TurnId, Unsubscribe } from './types.js';
import type { ClientEvent } from './wire.js';

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

// -----------------------------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------------------------

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  commitGraceMs: 400,
  maxCaptureMs: 8_000,
};

/** The capture graph's gate, narrowed to what turn-taking needs (`CapturePort` in session.ts). */
export interface TurnCapturePort {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** `PlaybackTracker`, narrowed. `audibleMs` is the number a truncate is sent with. */
export interface TurnPlaybackPort {
  audibleMs(): number;
}

export interface TurnControllerDeps {
  readonly send: (event: ClientEvent) => void;
  readonly capture: TurnCapturePort;
  readonly playback: TurnPlaybackPort;
  readonly now: () => MonoMs;
  /**
   * Resolves when the server reports `input_audio_buffer.speech_stopped`, or rejects/resolves
   * false on timeout. Injected rather than awaited internally so the grace is testable without a
   * real clock.
   */
  readonly awaitSpeechStopped: (withinMs: number) => Promise<boolean>;
  /** The transport decides who truncates on barge-in — see the table in §5.5. */
  readonly transportKind: 'webrtc' | 'websocket' | 'fake';
  /** The assistant item currently being spoken, or null. Owned by the session. */
  readonly currentItem: () => ItemId | null;
  readonly config?: TurnConfig;
  readonly onTurnId?: (turnId: TurnId) => void;
}

export interface TurnControllerEvents {
  onSubmitted(listener: (turnId: TurnId) => void): Unsubscribe;
  onTruncated(listener: (itemId: ItemId, audibleMs: number) => void): Unsubscribe;
}

let turnCounter = 0;

/**
 * Sequence numbers, not random ids: this package may not call `Math.random()` in a fixture-driven
 * test and expect the recording to reproduce.
 */
function nextTurnId(): TurnId {
  turnCounter += 1;
  return `turn_${String(turnCounter)}` as TurnId;
}

/** Test-only: the counter is module state, and a test that asserts an id needs it reset. */
export function resetTurnIds(): void {
  turnCounter = 0;
}

export function createTurnController(
  deps: TurnControllerDeps,
): TurnController & TurnControllerEvents {
  const config = deps.config ?? DEFAULT_TURN_CONFIG;
  const submitted = new Set<(turnId: TurnId) => void>();
  const truncated = new Set<(itemId: ItemId, audibleMs: number) => void>();

  let active: TurnId | null = null;

  /**
   * The one place a truncate is sent, so the "twice at two different offsets" failure has a
   * single site to not have.
   */
  const truncate = (): void => {
    const item = deps.currentItem();
    if (item === null) return;
    const audibleMs = Math.max(0, Math.round(deps.playback.audibleMs()));
    deps.send({
      type: 'conversation.item.truncate',
      item_id: item,
      content_index: 0,
      audio_end_ms: audibleMs,
    });
    for (const listener of truncated) listener(item, audibleMs);
  };

  return {
    beginTurn() {
      // Synchronous and cheap: this sits on the trigger path, where the overlay's ≤100 ms budget
      // forbids an `await` between the key press and the window being shown (overlay §9.1).
      const turnId = nextTurnId();
      active = turnId;
      deps.capture.open();
      deps.onTurnId?.(turnId);
      return turnId;
    },

    async endTurn(turnId, reason, context) {
      deps.capture.close();
      if (active !== turnId) return;
      active = null;

      if (reason === 'cancel') {
        deps.send({ type: 'input_audio_buffer.clear' });
        return;
      }

      // The commit race, and the cost of ADR-0017. With VAD on, the server commits the input
      // buffer when it sees speech *stop* — so a `response.create` sent the instant the key is
      // released can outrun the tail of the utterance and answer half a sentence. Waiting is
      // bounded: if the server never reports it, we proceed rather than hang, because a late
      // answer beats no answer.
      await deps.awaitSpeechStopped(config.commitGraceMs);

      // Snapshot before the response, always: the model sees the freshest possible state, and it
      // sees it before it is asked to speak.
      if (context.snapshotText !== '') {
        deps.send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: context.snapshotText }],
          },
        });
      }

      deps.send({ type: 'response.create' });
      for (const listener of submitted) listener(turnId);
    },

    interrupt() {
      /**
       * §5.5's table. On WebRTC with VAD on the server truncates when it sees the player speak,
       * and sending our own as well would truncate twice at two different offsets — the model's
       * idea of what it said would then be wrong in a way that is *harder* to reason about than
       * not truncating at all. On WebSocket nothing else will do it.
       */
      if (deps.transportKind === 'websocket') truncate();
      return Promise.resolve();
    },

    abort() {
      // The row that is easy to miss: a cancel has no speech behind it, so VAD never fired and no
      // server-side truncation happened. Cancel *and* truncate, or the model believes it finished
      // a sentence the player cut off — and every later turn is built on that.
      deps.send({ type: 'response.cancel' });
      truncate();
      if (deps.capture.isOpen) deps.capture.close();
      active = null;
      return Promise.resolve();
    },

    speakUnprompted(context) {
      // No capture, no gesture: the trigger policy already decided (dota2 §6.4).
      //
      // The id is reported even though nothing here allocates one. The session stamps every
      // `turn.*` event with the last id it was told about, and it used to be told only by
      // `beginTurn` — so a coaching turn's `responseStarted` and `responseEnded` went out under
      // whichever push-to-talk turn happened to run last, or under the empty string. The
      // composition root closes its ledger turn by matching that id, so every coaching turn closed
      // one that was not open and left its own open for the rest of the match.
      deps.onTurnId?.(context.turnId);
      if (context.snapshotText !== '') {
        deps.send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: context.snapshotText }],
          },
        });
      }
      deps.send({ type: 'response.create' });
      for (const listener of submitted) listener(context.turnId);
      return Promise.resolve();
    },

    onSubmitted(listener) {
      submitted.add(listener);
      return () => submitted.delete(listener);
    },

    onTruncated(listener) {
      truncated.add(listener);
      return () => truncated.delete(listener);
    },
  };
}

/**
 * The session: the facade, and the handle the overlay's `VoiceBridge` attaches to.
 *
 * One session per match. It opens at match start rather than at the first key press, for two
 * reasons: the cached prefix is paid once and warm before it is needed, and SDP negotiation is
 * ~300–500 ms that would otherwise land on the player's first utterance. An idle session costs
 * nothing — billing is per token and no tokens flow while the gate is shut (realtime §10).
 *
 * `SessionSupervisor` exists because a 45-minute match plus draft plus post-game can exceed the
 * 60-minute session cap. It rotates at ~50 minutes: open a second session, replay the
 * byte-identical preamble and the ledger's rehydration summary into it, swap, close the first.
 * Reconnection after a transport failure is the *same* machinery with a different trigger — which
 * is the main argument for building rotation at all, since it means the reconnect path is
 * exercised on every long match instead of only when the network fails.
 *
 * See docs/design/voice-input-architecture.md §5.7, §7.2.
 */

import type {
  Clock,
  ItemId,
  MonoMs,
  SessionId,
  TurnId,
  Unsubscribe,
  VoiceEvent,
  VoiceFault,
  VoiceTelemetry,
} from './types.js';
import { buildSessionUpdate, assertGaShape } from './session-config.js';
import { createTranscriptStream } from './transcript.js';
import { createContextWindowExecutor } from './window.js';
import { createTurnController } from './turn.js';
import { createCostMeter, MINI_RATES, DEFAULT_BUDGET_USD, type ModelRates } from './cost.js';
import { parseLocalCommand } from './commands.js';
import type { ServerEvent } from './wire.js';
import type { RealtimeSessionConfig } from './session-config.js';
import type { RealtimeTransport, TransportMedia } from './transport.js';
import type { TurnController } from './turn.js';
import type { ContextWindowExecutor } from './window.js';
import type { TranscriptStream } from './transcript.js';
import type { CostMeter } from './cost.js';
import type { CredentialPort } from './credentials.js';

/**
 * What `apps/desktop/src/main/adapters` attaches to (overlay-architecture.md §5.6). Deliberately
 * the narrow half: the adapter can observe and it can send the three commands the machine emits.
 * It cannot reach the transport, the window executor or the cost meter, none of which the
 * interaction machine has any business knowing about.
 */
export interface RealtimeSessionHandle {
  readonly sessionId: SessionId;
  onEvent(listener: (event: VoiceEvent) => void): Unsubscribe;
  interrupt(at: MonoMs): void;
  abort(): void;
}

export interface RealtimeSession extends RealtimeSessionHandle {
  readonly turns: TurnController;
  readonly window: ContextWindowExecutor;
  readonly transcripts: TranscriptStream;
  readonly cost: CostMeter;
  close(reason: string): Promise<void>;
}

/**
 * ⚠ Structural mirrors of `@riki/audio`'s `CaptureGraph` and `PlaybackTracker`, for the same reason
 * as the media handles in transport.ts: real imports need project references that do not exist
 * while everything is contracts. Step 7 replaces them.
 */
export interface CapturePort {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface PlaybackPort {
  audibleMs(): number;
}

export interface RealtimeSessionDeps {
  readonly transport: RealtimeTransport;
  readonly credentials: CredentialPort;
  readonly capture: CapturePort;
  readonly playback: PlaybackPort;
  readonly clock: Clock;
  readonly telemetry: VoiceTelemetry;
  /**
   * The real media, from the voice window: `CaptureGraph.outbound` going out, and the remote track
   * to hand `PlaybackTracker.attach`.
   *
   * Optional, and absent means a placeholder track and a discarded remote one — which is what
   * every fixture-driven test wants, since `FakeRealtimeTransport` has no media at all. It is
   * **not** optional in production, and the failure when it is missing is silent in both
   * directions: nothing is sent, nothing is heard, and no error is raised by either side.
   */
  readonly media?: TransportMedia;
}

/**
 * The preamble, from `packages/context`. ⚠ Structural mirror, as above.
 *
 * One field, where there were two. The other was a frozen tool manifest, and ADR-0023 deleted the
 * pull model it belonged to: what a turn needs is assembled and injected before the model is asked
 * to speak, so there is nothing for the session to advertise.
 */
export interface SessionContext {
  readonly preambleText: string;
}

export type SupervisorState =
  'idle' | 'connecting' | 'ready' | 'degraded' | 'rotating' | 'unavailable';

export interface SupervisorOptions {
  /** Default 50 min, against the API's 60-minute cap (realtime §1). */
  readonly rotateAfterMs: number;
  readonly reconnectBackoffMs: readonly number[];
}

/**
 * ⚠ **Declared, and deliberately not implemented here.** Renewal lives in
 * `apps/desktop/src/main/voice/session.ts` — ADR-0045.
 *
 * The reason is one line long: rotating a session needs a *fresh client secret*, minting needs the
 * `ApiKey`, and the key is in main while this code runs in a renderer (ADR-0015). A supervisor here
 * could only get one by asking main for it, and `CredentialPort.acquire()` in the voice window
 * resolves a constant — the secret it was handed in the `voice.session.open` directive. Giving it a
 * real implementation means a renderer→main *request* for a credential, which `schemas/voice.ts`
 * does not have and which is a protocol coordination event.
 *
 * Main can do the whole thing with what already exists: mint, and send `voice.session.open` again.
 * The renderer's handler already closes the live session before opening the new one, so rotation is
 * a directive rather than a mechanism. What this file keeps is the *detection* half — the error
 * code and the transport close, both above — which is the part that has to happen where the
 * transport is.
 */
export interface SessionSupervisor {
  start(context: SessionContext, config: RealtimeSessionConfig): Promise<RealtimeSessionHandle>;
  readonly state: SupervisorState;
  onStateChange(listener: (state: SupervisorState) => void): Unsubscribe;
  /** Rotation and reconnection are the same call; only the trigger differs. */
  rotate(reason: 'age' | 'lost'): Promise<void>;
  stop(reason: string): Promise<void>;
}

// -----------------------------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------------------------

export interface SessionOptions {
  readonly rates?: ModelRates;
  readonly budgetUsd?: number;
  /** Default 400 ms, matching `TurnConfig.commitGraceMs`. */
  readonly commitGraceMs?: number;
}

/**
 * The wire's error code, as a fault the layers above can act on.
 *
 * The ordering is the whole content of this function, and one row of it is load-bearing enough to
 * be worth stating: **the expiry test runs before the auth test.** `session_expired` is what the
 * API sends at the 60-minute cap (`SESSION_MAX_DURATION_MS`), and it is not an authentication
 * problem — it is the ordinary end of a session's life, and the only correct response is to open
 * another one. Classified as `auth` it would be persistent and non-retryable, which is exactly the
 * shape that stops a renewal supervisor from renewing and puts a permanent error on the chip
 * instead. Before ADR-0045 it did not match either test and fell through to `offline`, which was
 * retryable but named the wrong thing and left the reader looking for a network problem.
 *
 * `retryable: true` on the expiry row is what main's renewal reads (`main/voice/session.ts`); the
 * chip never sees it, because a renewal that succeeds swallows the fault.
 */
function faultFor(code: string, message: string): VoiceFault {
  if (code === 'beta-schema') {
    return { kind: 'session-lost', message, persistent: true, retryable: false };
  }
  if (/expired|session_lost|connection/i.test(code)) {
    return { kind: 'session-lost', message, persistent: false, retryable: true };
  }
  if (/auth|api_key|invalid_api_key/i.test(code)) {
    return { kind: 'auth', message, persistent: true, retryable: false };
  }
  return { kind: 'offline', message, persistent: false, retryable: true };
}

/**
 * The message on the fault a transport close produces.
 *
 * A constant because two places read it: the session emits it, and `main/voice/session.ts` puts it
 * in the inspector's trace as the reason a renewal started.
 */
export const TRANSPORT_CLOSED_MESSAGE = 'The Realtime transport closed while the session was open.';

/**
 * Wires the pieces together and translates the wire vocabulary into `VoiceEvent`.
 *
 * This function is the only place in Riki where a `response.*` name and a `turn.*` name appear in
 * the same scope. That is the whole point of it (overlay §5.6): when the API renames an event —
 * and research §3 documents that it already did once, silently — the diff is here and in
 * `wire.ts`, and the interaction machine never notices.
 */
export async function createRealtimeSession(
  deps: RealtimeSessionDeps,
  context: SessionContext,
  config: RealtimeSessionConfig,
  options: SessionOptions = {},
): Promise<RealtimeSession> {
  const listeners = new Set<(event: VoiceEvent) => void>();
  const emit = (event: VoiceEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const transcripts = createTranscriptStream();
  const window = createContextWindowExecutor({
    send: (event) => {
      deps.transport.send(event);
    },
  });
  const cost = createCostMeter(
    options.rates ?? MINI_RATES,
    options.budgetUsd ?? DEFAULT_BUDGET_USD,
  );

  let sessionId = '' as SessionId;
  let currentItem: ItemId | null = null;
  let currentTurn = '' as TurnId;
  let speechStoppedWaiter: ((stopped: boolean) => void) | null = null;
  /** Set by `close()`, so an orderly teardown does not look like a connection that failed. */
  let closing = false;
  /** One loss, one fault. See the `error` case and the `onStateChange` subscription below. */
  let reportedLoss = false;

  /**
   * Resolves on `input_audio_buffer.speech_stopped`, or on the grace expiring.
   *
   * The timer is the injected clock's, not `setTimeout`'s, so the 400 ms grace is assertable
   * without a real one. A grace that expires is not an error: a late answer beats no answer.
   */
  const awaitSpeechStopped = (withinMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (stopped: boolean): void => {
        if (settled) return;
        settled = true;
        speechStoppedWaiter = null;
        resolve(stopped);
      };
      speechStoppedWaiter = finish;
      const schedule = deps.clock.schedule?.bind(deps.clock);
      if (schedule === undefined) {
        // No scheduler injected means "do not wait": the turn submits immediately and may clip
        // the tail. Safe, and better than a wait that never ends.
        finish(false);
        return;
      }
      schedule(withinMs, () => {
        finish(false);
      });
    });

  const turns = createTurnController({
    send: (event) => {
      deps.transport.send(event);
    },
    capture: deps.capture,
    playback: deps.playback,
    now: () => deps.clock.now(),
    awaitSpeechStopped,
    transportKind: deps.transport.kind,
    currentItem: () => currentItem,
    ...(options.commitGraceMs === undefined
      ? {}
      : { config: { commitGraceMs: options.commitGraceMs, maxCaptureMs: 8_000 } }),
    onTurnId: (turnId) => {
      currentTurn = turnId;
    },
  });

  turns.onSubmitted((turnId) => {
    emit({ kind: 'turn', turnId, event: 'submitted' });
  });
  turns.onTruncated((itemId, audibleMs) => {
    deps.telemetry.truncation(audibleMs, deps.transport.kind);
    transcripts.cut(itemId, deps.clock.now());
  });

  cost.onBudgetExceeded((snapshot) => {
    emit({ kind: 'cost', usd: snapshot.usd, turns: snapshot.turns });
  });

  transcripts.onChunk((chunk) => {
    emit({
      kind: 'transcript',
      role: chunk.role,
      turnId: chunk.turnId,
      text: chunk.text,
      final: chunk.final,
    });

    // §6.2: the short list that must work when the model is unavailable. Player finals only —
    // parsing the agent's own words would let Riki mute itself by saying "stop".
    if (!chunk.final || chunk.role !== 'player') return;
    const match = parseLocalCommand(chunk.text);
    if (match === null) return;
    emit({ kind: 'command', command: match.command.kind, confidence: match.confidence });
  });

  const onServerEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        return;

      case 'input_audio_buffer.speech_started':
        // With the gate shut this can only be the model hearing itself — the loop in research
        // §11.5. It is the one signal `turn_detection: null` would have cost us (ADR-0017).
        if (!deps.capture.isOpen) deps.telemetry.selfInterruption();
        return;

      case 'input_audio_buffer.speech_stopped':
        speechStoppedWaiter?.(true);
        return;

      case 'input_audio_buffer.committed':
        return;

      case 'conversation.item.input_audio_transcription.completed':
        transcripts.completePlayer(currentTurn, event.item_id, event.transcript, deps.clock.now());
        return;

      case 'response.created':
        emit({ kind: 'turn', turnId: currentTurn, event: 'responseStarted' });
        return;

      case 'response.output_item.added':
        // The signal that starts playback measurement. On WebRTC there are no audio deltas at
        // all (research §2), so keying off them would leave barge-in unable to truncate.
        currentItem = event.item_id;
        return;

      case 'response.output_audio_transcript.done':
        transcripts.completeAgent(currentTurn, event.item_id, event.transcript, deps.clock.now());
        return;

      case 'response.function_call_arguments.done':
        // Counted and ignored, and never answered (coaching-architecture.md §2.4). The session is
        // configured with `tools: []`, so this is the model inventing a call — realtime §11.6
        // documents it narrating calls it did not make. Answering would be worse than silence: it
        // would create a `function_call_output` item for a call the conversation does not contain.
        // A non-zero counter here is a bug in the model or in our config, not a condition.
        deps.telemetry.strayToolCall(event.name);
        return;

      case 'response.done':
        if (event.usage !== null) {
          cost.record(event.usage);
          window.noteUsage(event.usage.inputAudioTokens + event.usage.textTokens, event.usage.at);
        }
        currentItem = null;
        emit({ kind: 'turn', turnId: currentTurn, event: 'responseEnded' });
        return;

      case 'rate_limits.updated':
      case 'unhandled':
        return;

      case 'error': {
        const fault = faultFor(event.code, event.message);
        // An expiry arrives as an error *and* as a closed transport, in either order. One loss is
        // one fault: whichever gets here first reports it and the other stays quiet. Reporting
        // both would have the supervisor above renew, finish, and immediately renew again.
        if (fault.kind === 'session-lost' && fault.retryable) {
          if (reportedLoss) return;
          reportedLoss = true;
        }
        deps.telemetry.fault(fault.kind);
        emit({ kind: 'fault', fault });
        return;
      }
    }
  };

  const unsubscribeTransport = deps.transport.onEvent(onServerEvent);

  /**
   * `level` and `speech` VoiceEvents are deliberately not emitted here. `CapturePort` is
   * open/close/isOpen — the session gates capture, it does not observe it. Those two streams come
   * off `CaptureGraph.onLevel` / `onSpeech` directly and are merged into the same `VoiceEvent`
   * stream by the composition root, which is the only place that holds both objects (§2.2).
   */

  const secret = await deps.credentials.acquire();
  sessionId = secret.sessionId;

  await deps.transport.connect(
    secret,
    deps.media ?? {
      kind: 'track',
      outbound: { id: 'outbound' },
      onRemoteTrack: () => {
        // No media injected: a fixture-driven test, where `FakeRealtimeTransport` ignores this
        // argument entirely. The voice window passes the real graph and attaches the tracker.
      },
    },
  );

  /**
   * The other half of expiry detection, and the half that has no event behind it.
   *
   * At the 60-minute cap the API sends `session_expired` **and** drops the connection, and the two
   * are not redundant: on WebRTC the data channel can go first, in which case the error never
   * arrives and the only evidence is a transport that stopped. Observed exactly that way on
   * 2026-08-09 — the error was in the log, then the channel closed, then ICE disconnected, and
   * nothing reconnected because nothing was listening for any of it.
   *
   * Armed only once `connect` has resolved. A close during negotiation is `connect`'s own rejection
   * and is already the caller's to handle; emitting a fault for it too would report one failure
   * twice.
   *
   * `closing` is what keeps an orderly `close()` — a match ending, a renewal tearing the old
   * session down — from looking like a failure. Without it, every renewal would raise the fault
   * that triggers a renewal.
   */
  const unsubscribeState = deps.transport.onStateChange((state) => {
    if (state !== 'closed' || closing || reportedLoss) return;
    reportedLoss = true;
    const fault = faultFor('connection', TRANSPORT_CLOSED_MESSAGE);
    deps.telemetry.fault(fault.kind);
    emit({ kind: 'fault', fault });
  });

  // Configure before anything else is sent: a session that receives audio before its format is
  // set interprets it with the default, which is the beta-schema failure by another route.
  const update = buildSessionUpdate({
    ...config,
    instructions: context.preambleText,
  });
  assertGaShape(update);
  deps.transport.send(update);

  return {
    sessionId,
    turns,
    window,
    transcripts,
    cost,

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    interrupt(at) {
      void turns.interrupt(at);
    },

    abort() {
      void turns.abort();
    },

    async close(reason) {
      // Before anything else: `transport.close()` below drives the state to `closed`, and an
      // orderly close must not be reported as a session that was lost.
      closing = true;
      unsubscribeState();
      unsubscribeTransport();
      transcripts.reset();
      window.noteSessionLost();
      listeners.clear();
      await deps.transport.close(reason);
    },
  };
}

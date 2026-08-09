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
import {
  assertRealtimeToolShape,
  buildToolManifest,
  callTool,
  parseToolCall,
  unknownOutput,
  type ToolDispatcher,
} from './tools.js';
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
  /**
   * What answers the model's tool calls — `packages/world-model`'s five tools, behind a port so
   * this package never learns what a `WorldState` is (ADR-0042, T3).
   *
   * **Optional, and its absence is what decides whether tools are advertised at all.** A session
   * with no dispatcher sends `tools: []` and answers nothing, which is exactly the pre-ADR-0042
   * behaviour; a session with one sends the manifest and dispatches. That coupling is deliberate:
   * advertising a tool nobody can answer would make every call a degraded reply, which is a worse
   * failure than the model working from the injected snapshot alone.
   *
   * It is optional rather than required because of where this code runs. The session lives in the
   * voice window and the world model lives in main (ADR-0002, ADR-0015), so a real dispatcher has
   * to reach across the preload bridge — a renderer→main *request*, which `schemas/voice.ts` does
   * not have and which is a protocol coordination event. Until that lands, production injects
   * nothing and Riki answers from the snapshot as it does today.
   */
  readonly tools?: ToolDispatcher;
}

/**
 * The preamble, from `packages/context`. ⚠ Structural mirror, as above.
 *
 * Still one field, and still not the tool manifest — but for the opposite reason to the one that
 * was here. ADR-0023 deleted the manifest because there was nothing to advertise; ADR-0042 brought
 * tools back, and the manifest is derived from `@riki/protocol`'s schemas rather than supplied
 * (`buildToolManifest`). A caller that could pass its own would be a second declaration of the tool
 * set, which is the drift `packages/protocol` exists to prevent.
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

  /**
   * The model asked the world a question. Answer it, and let it carry on speaking.
   *
   * **Never rejects, and never leaves a call unanswered once one has been advertised.** This runs
   * inside a response that is already being spoken, so every failure has the same shape as a
   * success: a `function_call_output` carrying `{ unknown: … }`, which is the encoding the model
   * already reads for a fact nobody observed (ADR-0043). A thrown dispatcher, a result its own
   * schema refuses, a tool name outside the five, arguments that do not parse — all four become a
   * degraded answer, because the alternative is a turn that stops mid-sentence with no audio and
   * no explanation the player can act on.
   *
   * The two cases that are *not* answered are the two where an answer could not land: a session
   * that advertised no tools, and a call with no id to address the output to.
   */
  const answerToolCall = async (
    call: Extract<ServerEvent, { type: 'response.function_call_arguments.done' }>,
  ): Promise<void> => {
    const dispatcher = deps.tools;
    if (dispatcher === undefined) {
      // `session.update` carried `tools: []`, so this names a tool the model invented — realtime
      // §11.6 records it doing exactly that, and narrating the arguments out loud. Answering would
      // put an output into the conversation for a call we never offered. This is the counter that
      // ADR-0023 said should read zero forever, and under ADR-0042 it still should.
      deps.telemetry.toolCallRejected(call.name, 'no-tools');
      return;
    }
    if (call.call_id === '') {
      deps.telemetry.toolCallRejected(call.name, 'no-call-id');
      return;
    }

    const parsed = parseToolCall(call.name, call.arguments);
    if (!parsed.ok) {
      // The model got the tool surface wrong, which is the most interesting thing it can do and
      // the one thing the inspector's dispatch decorator structurally cannot see (ADR-0047) —
      // nothing was dispatched. `detail` names the tool and what was wrong with it, so the answer
      // is also the correction.
      deps.telemetry.toolCallRejected(call.name, parsed.reason);
      turns.submitToolOutput(call.call_id, unknownOutput(parsed.detail));
      return;
    }

    let output: string;
    try {
      const encoded = await callTool(dispatcher, parsed.call);
      output = encoded.ok ? encoded.json : unknownOutput(encoded.detail);
    } catch (error) {
      output = unknownOutput(`\`${parsed.call.name}\` could not answer: ${String(error)}`);
    }
    turns.submitToolOutput(call.call_id, output);
  };

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
        // Deliberately not awaited, and this is the only `void` on an event path here. A dispatch
        // is the one handler that can take milliseconds, and `onServerEvent` is the transport's
        // synchronous listener — awaiting would hold up every event queued behind it, including
        // the `response.done` that ends the turn and the `error` that says the session is gone.
        // `answerToolCall` never rejects, which is what makes the floating promise safe rather
        // than merely quiet.
        void answerToolCall(event);
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

  /**
   * The manifest, and the two assertions that stand between it and a session that is configured
   * with no usable tools.
   *
   * Both failures here are silent in the same way and that is why both are asserted rather than
   * reviewed: a `session.update` in the beta shape misconfigures the audio, and a tool list in the
   * Chat Completions shape configures no tools at all. Neither errors. The second is
   * indistinguishable from a model that simply chose not to call anything, which is a thing models
   * do — so without the assertion the first evidence would be a match's worth of confident,
   * ungrounded answers.
   *
   * Empty when no dispatcher was injected: nothing is advertised that nothing can answer.
   */
  const tools = deps.tools === undefined ? [] : buildToolManifest();
  assertRealtimeToolShape(tools);

  // Configure before anything else is sent: a session that receives audio before its format is
  // set interprets it with the default, which is the beta-schema failure by another route.
  const update = buildSessionUpdate(
    {
      ...config,
      instructions: context.preambleText,
    },
    tools,
  );
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

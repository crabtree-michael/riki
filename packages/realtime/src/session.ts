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
  CallId,
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
import type { RealtimeTransport } from './transport.js';
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
  /**
   * Resolves a `read_screen` consent prompt. It arrives here because the overlay's only route
   * back to the rest of Riki is `VoiceCommandSink`; this forwards to the tool pipeline, which is
   * what is actually waiting (architecture §8.3).
   */
  resolveConsent(promptId: string, granted: boolean): void;
}

export interface RealtimeSession extends RealtimeSessionHandle {
  readonly turns: TurnController;
  readonly window: ContextWindowExecutor;
  readonly transcripts: TranscriptStream;
  readonly cost: CostMeter;
  close(reason: string): Promise<void>;
}

/**
 * ⚠ Structural mirrors of `@riki/audio`'s `CaptureGraph` and `PlaybackTracker`, and of the tool
 * pipeline's call port, for the same reason as the media handles in transport.ts: real imports
 * need project references that do not exist while everything is contracts. Step 7 replaces them.
 */
export interface CapturePort {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface PlaybackPort {
  audibleMs(): number;
}

/**
 * The seam with `agent-command-execution-architecture.md`. That document's rule holds on this
 * side too: every call produces exactly one result within its deadline, so this never rejects and
 * never resolves to nothing. A dropped call here is a hung session, which is the hardest bug class
 * in this component to reproduce and why `no-floating-promises` is an error repo-wide.
 */
export interface ToolCallPort {
  dispatch(call: {
    readonly callId: string;
    readonly name: string;
    readonly argumentsJson: string;
  }): Promise<{ readonly callId: string; readonly outputJson: string }>;
  resolveConsent(promptId: string, granted: boolean): void;
}

export interface RealtimeSessionDeps {
  readonly transport: RealtimeTransport;
  readonly credentials: CredentialPort;
  readonly capture: CapturePort;
  readonly playback: PlaybackPort;
  readonly tools: ToolCallPort;
  readonly clock: Clock;
  readonly telemetry: VoiceTelemetry;
}

/** The preamble and frozen manifest, from `packages/context`. ⚠ Structural mirror, as above. */
export interface SessionContext {
  readonly preambleText: string;
  readonly manifestJson: string;
}

export type SupervisorState =
  'idle' | 'connecting' | 'ready' | 'degraded' | 'rotating' | 'unavailable';

export interface SupervisorOptions {
  /** Default 50 min, against the API's 60-minute cap (realtime §1). */
  readonly rotateAfterMs: number;
  readonly reconnectBackoffMs: readonly number[];
}

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

function faultFor(code: string, message: string): VoiceFault {
  if (code === 'beta-schema') {
    return { kind: 'session-lost', message, persistent: true, retryable: false };
  }
  if (/auth|api_key|invalid_api_key/i.test(code)) {
    return { kind: 'auth', message, persistent: true, retryable: false };
  }
  if (/session_lost|connection/i.test(code)) {
    return { kind: 'session-lost', message, persistent: false, retryable: true };
  }
  return { kind: 'offline', message, persistent: false, retryable: true };
}

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

      case 'response.function_call_arguments.done': {
        emit({ kind: 'tool', event: 'started', name: event.name, callId: event.call_id });
        void dispatchTool(event.call_id, event.name, event.arguments);
        return;
      }

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
        deps.telemetry.fault(fault.kind);
        emit({ kind: 'fault', fault });
        return;
      }
    }
  };

  /**
   * Every call produces exactly one result within its deadline, so this never rejects and never
   * resolves to nothing (agent-command-execution §7.4). A dropped call here is a hung session.
   */
  async function dispatchTool(callId: CallId, name: string, argumentsJson: string): Promise<void> {
    try {
      const result = await deps.tools.dispatch({ callId, name, argumentsJson });
      deps.transport.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: result.callId, output: result.outputJson },
      });
    } catch {
      // A failure still has to be answered, or the model waits forever for a result that is
      // never coming — which is the stall C3 warns about.
      deps.transport.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ error: 'unavailable' }),
        },
      });
    }
    emit({ kind: 'tool', event: 'ended', name, callId });
    // The tool result is an item, not a turn: without this the model never speaks again.
    deps.transport.send({ type: 'response.create' });
  }

  const unsubscribeTransport = deps.transport.onEvent(onServerEvent);

  /**
   * `level` and `speech` VoiceEvents are deliberately not emitted here. `CapturePort` is
   * open/close/isOpen — the session gates capture, it does not observe it. Those two streams come
   * off `CaptureGraph.onLevel` / `onSpeech` directly and are merged into the same `VoiceEvent`
   * stream by the composition root, which is the only place that holds both objects (§2.2).
   */

  const secret = await deps.credentials.acquire();
  sessionId = secret.sessionId;

  await deps.transport.connect(secret, {
    kind: 'track',
    outbound: { id: 'outbound' },
    onRemoteTrack: () => {
      /* the voice window attaches the playback tracker */
    },
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

    resolveConsent(promptId, granted) {
      deps.tools.resolveConsent(promptId, granted);
      emit({ kind: 'consent', event: 'resolved', promptId });
    },

    async close(reason) {
      unsubscribeTransport();
      transcripts.reset();
      window.noteSessionLost();
      listeners.clear();
      await deps.transport.close(reason);
    },
  };
}

/**
 * The composition root's voice half — voice-input-architecture.md §7.3, and the thing that
 * replaces `shell/silent-session.ts`.
 *
 * It is a `CoachingSessionPort`, so the coaching agent above it cannot tell the difference between
 * this and the stand-in. What it adds underneath is everything: `@riki/config` yields the key,
 * `ClientSecretBroker` mints from it, the voice window is created and handed the secret plus the
 * session config, and `VoiceEvent`s come back the other way.
 *
 * ## What this file is careful about
 *
 * **The key never leaves this process.** `ApiKey` goes into `ClientSecretBroker` and nothing else;
 * what crosses the bridge is a short-lived client secret (ADR-0015). `schemas/voice.ts` has no
 * field that could carry a key, and a test asserts that as a shape.
 *
 * **Turn ids are allocated here.** `beginTurn` is synchronous — the overlay's ≤100 ms budget
 * forbids an await between the key press and the window being shown — so it cannot wait for a
 * renderer to answer with one. It allocates, sends, and returns in the same tick.
 *
 * **Nothing is sent before the renderer says it is listening.** A directive sent before
 * `voice.ready` is a message with no listener and produces a session that never opens and never
 * errors. Directives queue until then, so the caller does not have to know.
 *
 * **A failure is a fault on the chip, never a rejected promise.** `speakUnprompted` and `endTurn`
 * resolve to "handed over", not to "finished speaking" — the agent closes the turn from the event
 * stream — so rejecting them would leave gate 4 (`agent_speaking`) armed forever and suppress
 * every later trigger. That is the one confusion `silent-session.ts` was written to avoid, and it
 * is just as easy to reintroduce here.
 */

import type { RikiConfig } from '@riki/config';
import type { TurnId } from '@riki/context';
import type { VoiceDirective, VoiceUpdate } from '@riki/protocol';
import { voice } from '@riki/protocol';
import type {
  ApiKey,
  CaptureMode,
  ClientSecretBroker,
  TurnEndReason,
  VoiceEvent,
  VoiceFault,
} from '@riki/realtime';
import { createClientSecretBroker } from '@riki/realtime';
import type { MonoMs } from '@riki/world-model';

import type { CoachingSessionPort, SessionTurn, SpeakReason } from '../agent/index.js';
import type { VoiceWindow, VoiceWindowFactory } from './contracts.js';

/**
 * The session's own view of what happened, for the tray's health line and for tests.
 *
 * `unavailable` is the resting state with no API key: the app boots, everything upstream of speech
 * runs, and the UI says voice is off (ADR-0006). It is not an error.
 */
export type VoiceSessionState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'unavailable';

export interface VoiceSessionTelemetry {
  /** What Riki *would* have said, as inputs. The rendered text is never logged (privacy §10). */
  speaking(turnId: TurnId, reason: SpeakReason | null, chars: number): void;
  fault(kind: VoiceFault['kind'], message: string): void;
  state(state: VoiceSessionState): void;
  /** Undecodable traffic on the bridge. Should be zero — both sides are one build. */
  bridgeProblem(detail: string): void;
}

export interface VoiceSessionDeps {
  readonly config: RikiConfig;
  readonly windows: VoiceWindowFactory;
  readonly clock: { now(): MonoMs };
  /**
   * A stable, hashed install id. realtime research §6 is explicit that a client-supplied safety
   * identifier is worthless for abuse attribution, and dota2 §7 requires the Steam ID be hashed
   * before any egress — both point at this being computed in main and passed in.
   */
  readonly safetyIdentifier: string;
  /** `globalThis.fetch`. Injected so minting is testable with no network. */
  readonly fetch: Parameters<typeof createClientSecretBroker>[0]['fetch'];
  readonly telemetry?: VoiceSessionTelemetry;
}

export interface VoiceSession extends CoachingSessionPort {
  readonly state: VoiceSessionState;
  /**
   * Open a Realtime session for this match.
   *
   * Per match rather than per app: `SessionContext` is frozen at `match_started` (ADR-0011), the
   * ledger and the coaching memory are per-match (ADR-0012, ADR-0013), and the API's own session
   * cap is 60 minutes. It opens at match start rather than at the first key press because SDP
   * negotiation is 300–500 ms that would otherwise land on the player's first utterance, and an
   * idle session costs nothing — billing is per token and no tokens flow while the gate is shut.
   */
  openMatch(preambleText: string): Promise<void>;
  closeMatch(reason: string): Promise<void>;
  /** Overlay §5.5: level frames cross while the chip can show bars, and not otherwise. */
  setLevelsEnabled(enabled: boolean): void;
  dispose(): Promise<void>;
}

/** Sequence numbers, not random ids: a fixture-driven test has to reproduce them. */
let turnCounter = 0;

export function resetVoiceTurnIds(): void {
  turnCounter = 0;
}

function nextTurnId(): TurnId {
  turnCounter += 1;
  return `voice_${String(turnCounter)}` as TurnId;
}

export function createVoiceSession(deps: VoiceSessionDeps): VoiceSession {
  const telemetry = deps.telemetry;
  const listeners = new Set<(event: VoiceEvent) => void>();

  let window: VoiceWindow | null = null;
  let ready = false;
  /** Directives that arrived before `voice.ready`. See the header. */
  let queued: VoiceDirective[] = [];
  let state: VoiceSessionState = 'idle';
  let disposed = false;

  const apiKey: ApiKey | null = deps.config.openai.apiKey;

  const broker: ClientSecretBroker | null =
    apiKey === null
      ? null
      : createClientSecretBroker({
          // The one place the key is used, and it does not leave this closure. `ApiKey.reveal()`
          // has exactly one call site inside that package too — ADR-0022.
          apiKey,
          safetyIdentifier: deps.safetyIdentifier,
          fetch: deps.fetch,
          now: () => deps.clock.now(),
        });

  function setState(next: VoiceSessionState): void {
    if (state === next) return;
    state = next;
    telemetry?.state(next);
  }

  function emit(event: VoiceEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function raise(kind: VoiceFault['kind'], message: string, retryable: boolean): void {
    telemetry?.fault(kind, message);
    emit({ kind: 'fault', fault: { kind, message, persistent: !retryable, retryable } });
  }

  function send(directive: VoiceDirective): void {
    if (window === null) return;
    if (!ready) {
      queued.push(directive);
      return;
    }
    window.send(directive);
  }

  function onUpdate(update: VoiceUpdate): void {
    switch (update.type) {
      case 'voice.ready': {
        ready = true;
        const pending = queued;
        queued = [];
        for (const directive of pending) window?.send(directive);
        return;
      }

      case 'voice.event': {
        const event = update.event;
        if (event.kind === 'level') {
          // The renderer sends no timestamp — the two processes share no monotonic epoch
          // (schemas/voice.ts). Main stamps it, which is the clock the overlay's ballistics use.
          emit({
            kind: 'level',
            source: event.source,
            value: event.value,
            at: deps.clock.now(),
          });
          return;
        }
        if (event.kind === 'fault') telemetry?.fault(event.fault.kind, event.fault.message);
        emit(event as VoiceEvent);
        return;
      }

      case 'voice.session.state':
        setState(update.state);
        return;

      case 'voice.window.applied':
        // `packages/context`'s `applyWindowPlan` is the consumer, and the composition root has not
        // wired the retention loop to a producer yet — nothing in main builds a `WindowPlan`
        // today. Accepted rather than dropped as unknown so that wiring is a one-line change here
        // rather than a protocol change.
        return;
    }
  }

  /**
   * Ensure the window exists.
   *
   * Created lazily and kept for the app's lifetime rather than per match: it costs a renderer
   * process to construct and the first one pays a cold Chromium start, which is exactly the
   * 300–500 ms `openMatch` exists to keep off the player's first utterance.
   */
  function ensureWindow(): VoiceWindow | null {
    if (disposed) return null;
    if (window !== null) return window;

    const created = deps.windows.create();
    window = created;
    ready = false;
    created.onUpdate(onUpdate);
    created.onProblem((detail) => {
      telemetry?.bridgeProblem(detail);
    });
    return created;
  }

  /**
   * Everything that has to happen before the renderer can be told to open a session, in the order
   * a failure is most likely: no key, then a refused mint.
   */
  async function open(preambleText: string): Promise<void> {
    if (broker === null) {
      // Not a fault on the chip. The app boots with voice disabled and says so (ADR-0006), and
      // this is the mode every test and every keyless machine runs in — raising a persistent
      // `auth` fault here would put a permanent error on an overlay that is working as designed.
      setState('unavailable');
      return;
    }

    if (ensureWindow() === null) return;
    setState('connecting');

    const sessionConfig = {
      model: deps.config.realtime.model,
      voice: deps.config.realtime.voice,
      instructions: preambleText,
      // ADR-0017. VAD stays on so server-side barge-in truncation keeps working, and the gesture
      // — never the model — decides when a response is created.
      turnDetection: {
        kind: 'server_vad' as const,
        createResponse: false as const,
        interruptResponse: true,
        silenceDurationMs: 200,
      },
      noiseReduction: 'near_field' as const,
      transcription: { model: 'gpt-4o-mini-transcribe', language: null },
      truncation: { mode: 'auto' as const, retentionRatio: 0.8 },
    };

    let secret;
    try {
      secret = await broker.mint(sessionConfig);
    } catch (error: unknown) {
      const fault = error as Partial<VoiceFault>;
      setState(fault.retryable === true ? 'degraded' : 'unavailable');
      raise(
        fault.kind ?? 'auth',
        error instanceof Error ? error.message : String(error),
        fault.retryable ?? false,
      );
      return;
    }

    send(
      voice.sessionOpen({
        secret: {
          value: secret.value,
          // A *duration*, because the renderer's monotonic epoch is not ours (schemas/voice.ts).
          expiresInMs: Math.max(0, Math.round(secret.expiresAt - deps.clock.now())),
          sessionId: secret.sessionId,
        },
        session: sessionConfig,
        capture: {
          deviceId: deps.config.audio.inputDeviceId,
          // Never false on the product path: without it the model hears itself and self-interrupts
          // in a loop, which is the reason the shell is Electron at all (ADR-0001).
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          preRollMs: deps.config.audio.preRollMs,
        },
        transport: deps.config.realtime.transport,
        budgetUsd: deps.config.realtime.budgetUsd,
      }),
    );
  }

  return {
    get state(): VoiceSessionState {
      return state;
    },

    async openMatch(preambleText: string): Promise<void> {
      await open(preambleText);
    },

    closeMatch(reason: string): Promise<void> {
      // The window stays; only the session inside it closes. Destroying and recreating a renderer
      // between matches would put a cold Chromium start on the first utterance of the next one.
      send(voice.sessionClose(reason));
      setState('idle');
      return Promise.resolve();
    },

    setLevelsEnabled(enabled: boolean): void {
      send(voice.levelEnable(enabled));
    },

    // ---------------------------------------------------------------------------------------
    // CoachingSessionPort
    // ---------------------------------------------------------------------------------------

    speakUnprompted(turn: SessionTurn, reason: SpeakReason): Promise<void> {
      telemetry?.speaking(turn.turnId, reason, turn.snapshotText.length);
      send(voice.turnSpeak(turn.turnId, turn.snapshotText, reason.eventId, reason.salience));
      // Resolves to "handed over", not to "finished speaking" — see the header. The agent closes
      // the turn from `turn.responseEnded`, which is what disarms gate 4.
      return Promise.resolve();
    },

    beginTurn(mode: CaptureMode, now: MonoMs): TurnId {
      void now;
      const turnId = nextTurnId();
      send(voice.turnBegin(turnId, mode));
      return turnId;
    },

    endTurn(turnId: TurnId, reason: TurnEndReason, turn: SessionTurn): Promise<void> {
      if (reason !== 'cancel') telemetry?.speaking(turnId, null, turn.snapshotText.length);
      send(voice.turnEnd(turnId, reason, turn.snapshotText));
      return Promise.resolve();
    },

    abort(): Promise<void> {
      send(voice.command('abort'));
      return Promise.resolve();
    },

    onEvent(listener: (event: VoiceEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await this.closeMatch('app quitting');
      window?.close();
      window = null;
      ready = false;
      queued = [];
      listeners.clear();
      setState('idle');
    },
  };
}

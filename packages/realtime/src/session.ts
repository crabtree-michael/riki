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
 * See docs/design/voice-input-architecture.md §5.7, §7.2. Declarations only.
 */

import type { Clock, MonoMs, SessionId, Unsubscribe, VoiceEvent, VoiceTelemetry } from './types.js';
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

export declare function createRealtimeSession(
  deps: RealtimeSessionDeps,
  context: SessionContext,
  config: RealtimeSessionConfig,
): Promise<RealtimeSession>;

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

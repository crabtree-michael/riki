/**
 * The interaction machine's own vocabulary: state, inputs, effects.
 *
 * Declarations only. The reducer that consumes them is specified in
 * docs/design/overlay-architecture.md §4 and lands with REPO_SKELETON.md §10 step 6.
 *
 * Nothing here may reference Electron, @riki/realtime or @riki/audio. The machine is pure and
 * vendor-free; the adapters in main/adapters exist to hold those imports (§5.6).
 */

import type { Millis } from '../../shared/overlay.js';

export type CaptureMode = 'push' | 'latch';

export type FaultKind =
  'mic-denied' | 'no-input-device' | 'offline' | 'auth' | 'session-lost' | 'no-speech-detected';

export interface Fault {
  readonly kind: FaultKind;
  /** Permission faults persist until resolved; the rest auto-dismiss after 4 s (ui-design §8). */
  readonly persistent: boolean;
  readonly message: string;
}

export type TimerId =
  | 'silence-nudge'
  | 'listen-timeout'
  | 'elapsed-hint'
  | 'cancel-hint'
  | 'error-dismiss'
  | 'hide-hold';

export interface PendingTimer {
  readonly id: TimerId;
  readonly dueAt: Millis;
}

/**
 * Muted is deliberately absent: it is a condition, not a phase, and modelling it as one would
 * add eighteen impossible combinations to the reducer (§4.2).
 *
 * `acting` and `confirming` are absent because ADR-0023 deleted their only producers — a tool call
 * slow enough to need its own pixels, and the consent gate in front of `read_screen`.
 *
 * `speaking` used to carry `unprompted: boolean`, distinguishing an answer from a coaching turn
 * that started itself. ADR-0042 deleted the second kind: every phase here is now reached from a key
 * press, so the flag had one value and the projections never read it.
 */
export type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'armed'; readonly gesture: CaptureMode }
  | {
      readonly kind: 'listening';
      readonly gesture: CaptureMode;
      readonly silentSince: Millis | null;
    }
  | { readonly kind: 'processing'; readonly startedAt: Millis }
  | { readonly kind: 'speaking' }
  | { readonly kind: 'error'; readonly fault: Fault };

/** The settings snapshot the machine is allowed to know about, injected from @riki/config. */
export interface MachineEnvironment {
  readonly silenceNudgeMs: Millis;
  readonly listenTimeoutMs: Millis;
  readonly holdThresholdMs: Millis;
  readonly captionsEnabled: boolean;
  readonly earconsEnabled: boolean;
  readonly duckingEnabled: boolean;
}

export interface MachineState {
  readonly phase: Phase;
  readonly since: Millis;
  readonly muted: boolean;
  readonly latched: boolean;
  readonly pending: readonly PendingTimer[];
  /** "Fail loudly, but only once" (ui-design.md §1.6): a repeat fault transitions silently. */
  readonly reported: readonly FaultKind[];
  readonly env: MachineEnvironment;
  readonly revision: number;
}

export type TriggerEvent =
  | { readonly kind: 'down' }
  | { readonly kind: 'up' }
  | { readonly kind: 'tap' }
  | { readonly kind: 'cancel' };

export type MachineInput =
  | { readonly kind: 'trigger'; readonly event: TriggerEvent }
  | { readonly kind: 'capture'; readonly event: 'opened' | 'firstAudio' | 'closed' }
  | { readonly kind: 'speech'; readonly event: 'silence' | 'resumed' }
  | { readonly kind: 'turn'; readonly event: 'submitted' | 'responseStarted' | 'responseEnded' }
  | { readonly kind: 'fault'; readonly fault: Fault }
  | { readonly kind: 'mute'; readonly muted: boolean }
  | { readonly kind: 'settings'; readonly env: MachineEnvironment }
  | { readonly kind: 'timer'; readonly id: TimerId }
  | { readonly kind: 'intent'; readonly intent: RendererIntent };

/** The subset of OverlayIntent the machine acts on; `paint` and `fault` never reach it. */
export interface RendererIntent {
  readonly kind: 'cancel';
}

export type EarconId = 'capture-start' | 'capture-end' | 'error';

export type VoiceCommand =
  /** Barge-in. @riki/realtime turns this into conversation.item.truncate (voice-realtime skill). */
  { readonly kind: 'interrupt'; readonly at: Millis } | { readonly kind: 'abort' };

/**
 * The reducer returns descriptions, never calls. A `window` effect that makes the overlay
 * visible is always applied first — it is the only thing on the 100 ms path (§4.1).
 */
export type Effect =
  | { readonly kind: 'window'; readonly visible: boolean; readonly holdMs?: Millis }
  | { readonly kind: 'project' }
  | { readonly kind: 'schedule'; readonly id: TimerId; readonly delayMs: Millis }
  | { readonly kind: 'cancel'; readonly id: TimerId }
  | { readonly kind: 'levels'; readonly running: boolean; readonly source: 'input' | 'output' }
  | { readonly kind: 'earcon'; readonly sound: EarconId }
  | { readonly kind: 'duck'; readonly on: boolean }
  | { readonly kind: 'voice'; readonly command: VoiceCommand };

export interface Transition {
  readonly state: MachineState;
  readonly effects: readonly Effect[];
}

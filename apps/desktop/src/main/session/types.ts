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

/** Short verbs only, because Acting renders one on the chip (ui-design.md §5.1). */
export type ActingVerb = 'reading' | 'looking-up' | 'checking';

export type FaultKind =
  'mic-denied' | 'no-input-device' | 'offline' | 'auth' | 'session-lost' | 'no-speech-detected';

export interface Fault {
  readonly kind: FaultKind;
  /** Permission faults persist until resolved; the rest auto-dismiss after 4 s (ui-design §8). */
  readonly persistent: boolean;
  readonly message: string;
}

/** The one consequential thing Riki does: a frame leaving the machine for a VLM (§4.4). */
export interface ConfirmPrompt {
  readonly id: string;
  readonly question: string;
  readonly action: 'read-screen';
}

export type TimerId =
  | 'silence-nudge'
  | 'listen-timeout'
  | 'elapsed-hint'
  | 'cancel-hint'
  | 'error-dismiss'
  | 'confirm-timeout'
  | 'hide-hold';

export interface PendingTimer {
  readonly id: TimerId;
  readonly dueAt: Millis;
}

/**
 * Muted is deliberately absent: it is a condition, not a phase, and modelling it as one would
 * add eighteen impossible combinations to the reducer (§4.2).
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
  | { readonly kind: 'acting'; readonly verb: ActingVerb }
  | { readonly kind: 'confirming'; readonly prompt: ConfirmPrompt }
  | { readonly kind: 'speaking'; readonly unprompted: boolean }
  | { readonly kind: 'error'; readonly fault: Fault };

/** The settings snapshot the machine is allowed to know about, injected from @riki/config. */
export interface MachineEnvironment {
  readonly silenceNudgeMs: Millis;
  readonly listenTimeoutMs: Millis;
  readonly holdThresholdMs: Millis;
  readonly confirmTimeoutMs: Millis;
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
  | { readonly kind: 'cancel' }
  | { readonly kind: 'confirm'; readonly answer: boolean };

export type MachineInput =
  | { readonly kind: 'trigger'; readonly event: TriggerEvent }
  | { readonly kind: 'capture'; readonly event: 'opened' | 'firstAudio' | 'closed' }
  | { readonly kind: 'speech'; readonly event: 'silence' | 'resumed' }
  | { readonly kind: 'turn'; readonly event: 'submitted' | 'responseStarted' | 'responseEnded' }
  | { readonly kind: 'tool'; readonly event: 'started' | 'ended'; readonly verb: ActingVerb }
  | {
      readonly kind: 'consent';
      readonly event: 'requested' | 'resolved';
      readonly prompt: ConfirmPrompt;
    }
  /** The chip appears with no gesture behind it (dota2 §6.4; ui-design §13.6 left this open). */
  | { readonly kind: 'unprompted'; readonly event: 'speechStarted' }
  | { readonly kind: 'fault'; readonly fault: Fault }
  | { readonly kind: 'mute'; readonly muted: boolean }
  | { readonly kind: 'settings'; readonly env: MachineEnvironment }
  | { readonly kind: 'timer'; readonly id: TimerId }
  | { readonly kind: 'intent'; readonly intent: RendererIntent };

/** The subset of OverlayIntent the machine acts on; `paint` and `fault` never reach it. */
export type RendererIntent =
  { readonly kind: 'cancel' } | { readonly kind: 'confirm'; readonly answer: boolean };

export type EarconId = 'capture-start' | 'capture-end' | 'error';

export type ConfirmKey = 'yes' | 'no' | 'escape';

export type VoiceCommand =
  /** Barge-in. @riki/realtime turns this into conversation.item.truncate (voice-realtime skill). */
  | { readonly kind: 'interrupt'; readonly at: Millis }
  | { readonly kind: 'abort' }
  | { readonly kind: 'consent'; readonly promptId: string; readonly granted: boolean };

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
  | { readonly kind: 'keys'; readonly grab: readonly ConfirmKey[] }
  | { readonly kind: 'voice'; readonly command: VoiceCommand };

export interface Transition {
  readonly state: MachineState;
  readonly effects: readonly Effect[];
}

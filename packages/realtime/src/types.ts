/**
 * This package's vocabulary, and — in `VoiceEvent` — the vendor-free stream everything else
 * consumes.
 *
 * The overlay's interaction machine has never heard of `response.output_audio.done`; it has heard
 * of `turn.responseEnded` (overlay-architecture.md §5.6). `VoiceEvent` is the type that makes that
 * true, and its adapter is a translation table in one file. When the Realtime API's event names
 * change — openai-realtime-research.md §3 documents that they already did once, silently — the
 * diff stops there.
 *
 * See docs/design/voice-input-architecture.md §7.2. Declarations only.
 *
 * ⚠ Transitional. The branded scalars belong to @riki/protocol per REPO_SKELETON.md §4 (step 2,
 * still empty), as does `VoiceEvent` itself — it crosses the voice window's preload bridge.
 * `TurnId` is `packages/context`'s; declared structurally here rather than imported so this package
 * states its seam without reaching into another package's directory.
 */

/** Local monotonic milliseconds. Never wall-clock. */
export type MonoMs = number & { readonly __brand: 'MonoMs' };

export type Unsubscribe = () => void;

export interface Clock {
  now(): MonoMs;
  /**
   * Fires `fire` after `delayMs`, returning a canceller.
   *
   * Optional because most of this package only reads the clock. It exists because §5.4's commit
   * grace has to be *bounded* — a wait for `speech_stopped` that never times out is a hung turn —
   * and a bare `setTimeout` would make that 400 ms unassertable. Absent means "do not wait",
   * which is safe: the turn submits immediately and may clip the tail.
   */
  schedule?(delayMs: number, fire: () => void): () => void;
}

export type SessionId = string & { readonly __brand: 'SessionId' };
export type TurnId = string & { readonly __brand: 'TurnId' };
export type ResponseId = string & { readonly __brand: 'ResponseId' };
/** A conversation item id, as the API assigns it. The join key for truncation and deletion. */
export type ItemId = string & { readonly __brand: 'ItemId' };

export type ModelId = 'gpt-realtime-2.1' | 'gpt-realtime-2.1-mini';

/** realtime §11.8: the voice is locked once audio starts, so this is a per-session choice. */
export type VoiceName =
  'alloy' | 'ash' | 'ballad' | 'cedar' | 'coral' | 'echo' | 'marin' | 'sage' | 'shimmer' | 'verse';

// -----------------------------------------------------------------------------------------------
// Faults
// -----------------------------------------------------------------------------------------------

/**
 * Exactly the overlay's `FaultKind`, minus `no-speech-detected` — that one is produced by the
 * machine's own listen-timeout timer and never by us. The adapter's mapping is therefore the
 * identity, which is the point of matching the set.
 */
export type VoiceFaultKind = 'mic-denied' | 'no-input-device' | 'offline' | 'auth' | 'session-lost';

export interface VoiceFault {
  readonly kind: VoiceFaultKind;
  /** Permission and device faults persist until resolved; the rest auto-dismiss (ui-design §8). */
  readonly persistent: boolean;
  readonly message: string;
  /** Whether retrying can help. `auth` never is — it names the environment variable instead. */
  readonly retryable: boolean;
}

// -----------------------------------------------------------------------------------------------
// Usage and cost
// -----------------------------------------------------------------------------------------------

/**
 * What the session reports, per turn. Cached input is broken out because at an 80× discount it is
 * the only number in the bill that matters (realtime §10, architecture §5.8).
 */
export interface TokenUsage {
  readonly inputAudioTokens: number;
  readonly cachedInputTokens: number;
  readonly outputAudioTokens: number;
  readonly textTokens: number;
  readonly at: MonoMs;
}

// -----------------------------------------------------------------------------------------------
// The event stream
// -----------------------------------------------------------------------------------------------

export type LocalCommandKind = 'stop' | 'mute' | 'quiet-mode' | 'cancel';

export type VoiceEvent =
  | { readonly kind: 'capture'; readonly event: 'opened' | 'firstAudio' | 'closed' }
  | { readonly kind: 'speech'; readonly event: 'silence' | 'resumed' }
  | {
      readonly kind: 'turn';
      readonly turnId: TurnId;
      readonly event: 'submitted' | 'responseStarted' | 'responseEnded';
    }
  | {
      readonly kind: 'transcript';
      readonly role: 'player' | 'agent';
      readonly turnId: TurnId;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly kind: 'command'; readonly command: LocalCommandKind; readonly confidence: number }
  | {
      readonly kind: 'level';
      readonly source: 'input' | 'output';
      readonly value: number;
      readonly at: MonoMs;
    }
  | { readonly kind: 'cost'; readonly usd: number; readonly turns: number }
  | { readonly kind: 'fault'; readonly fault: VoiceFault };

/**
 * The other direction — the overlay's `VoiceCommand`, which this package executes.
 *
 * `interrupt` carries the moment the player interrupted rather than the moment we got round to
 * handling it, because that difference is milliseconds of audio the model would otherwise believe
 * were heard.
 */
export type VoiceCommand =
  { readonly kind: 'interrupt'; readonly at: MonoMs } | { readonly kind: 'abort' };

/**
 * `console.*` is confined to `packages/telemetry` (REPO_SKELETON.md §6.2), so this is a port.
 * Nothing here carries a transcript or a credential: both are redacted at the sink, and the
 * cheapest way to keep that true is to have nothing to redact.
 */
export interface VoiceTelemetry {
  turnLatency(phase: 'release-to-submit' | 'submit-to-audio', ms: number): void;
  truncation(audibleMs: number, transport: string): void;
  windowDrop(count: number, reason: string): void;
  fault(kind: VoiceFaultKind): void;
  cost(usd: number, cachedFraction: number): void;
  /** `speech_started` while our gate is shut: the model is hearing itself (architecture §9). */
  selfInterruption(): void;
  /**
   * A `response.function_call_arguments.done` from a session configured with `tools: []`.
   *
   * Should be zero, forever. It exists because realtime §11.6 records the model narrating tool
   * calls it did not make and leaking call arguments into speech — so a model told it has no tools
   * emitting one anyway is a thing we want a counter for rather than an unhandled event. Nothing
   * dispatches it and nothing answers it (coaching-architecture.md §2.4).
   */
  strayToolCall(name: string): void;
}

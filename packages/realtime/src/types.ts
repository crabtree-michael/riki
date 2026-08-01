/**
 * The vocabulary of a Realtime session, as this package models it.
 *
 * Deliberately *not* the wire vocabulary — that lives in `protocol/`. Nothing outside this
 * package should ever see the string `response.output_audio.delta`; the names here are the ones
 * the rest of Riki speaks, and `protocol/` holds the translation. That is the same reasoning
 * that puts `VoiceBridge` in the composition root (overlay-architecture.md §5.6): the Realtime
 * event names have already changed once, silently, and the diff should be confined to one file
 * with a table in it.
 */

export type Millis = number;
export type Tokens = number;
export type UsdCents = number;

export type Unsubscribe = () => void;

/**
 * openai-realtime-research.md §1. `mini` is the default for the reason §10 gives: it is roughly a
 * third of the audio cost, and cost is the lever that decides whether this ships at all.
 */
export type RealtimeModel = 'gpt-realtime-2.1' | 'gpt-realtime-2.1-mini' | 'gpt-realtime';

/** §11.8 — voice is locked once audio starts, so this is a per-session choice. */
export type RealtimeVoice =
  'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';

/** ADR-0002 makes WebRTC the transport; websocket exists for replay and for server-side tests. */
export type TransportKind = 'webrtc' | 'websocket';

/**
 * §4. `null` is push-to-talk and is Riki's default per ADR-0004 — the hotkey decides when a turn
 * ends, not the model.
 */
export type TurnDetectionMode = 'server_vad' | 'semantic_vad' | null;

/** §4. `near_field` for a headset, which is what a Dota player is wearing. */
export type NoiseReduction = 'near_field' | 'far_field' | null;

/** Shared limits for the `gpt-realtime` family (§1). Small, and the binding constraint. */
export const CONTEXT_WINDOW_TOKENS: Tokens = 32_768;
export const MAX_OUTPUT_TOKENS: Tokens = 4_096;
/** What is actually available for conversation: the window less the reserved output. */
export const INPUT_CEILING_TOKENS: Tokens = CONTEXT_WINDOW_TOKENS - MAX_OUTPUT_TOKENS;
/** Instructions + tool definitions share this cap (§1). ADR-0011 freezes them per session. */
export const INSTRUCTIONS_AND_TOOLS_BUDGET: Tokens = 16_384;
/** §1. A Dota match is 35–45 minutes, so this is reachable. */
export const MAX_SESSION_DURATION_MS: Millis = 60 * 60 * 1000;

/** §10: user audio accrues 1 token per 100 ms, assistant audio 1 per 50 ms. */
export const USER_AUDIO_TOKENS_PER_MS = 1 / 100;
export const ASSISTANT_AUDIO_TOKENS_PER_MS = 1 / 50;

export interface ToolDefinition {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface SessionConfig {
  readonly model: RealtimeModel;
  readonly voice: RealtimeVoice;
  readonly instructions: string;
  /** Frozen for the session's lifetime per ADR-0011. */
  readonly tools: readonly ToolDefinition[];
  readonly turnDetection: TurnDetectionMode;
  readonly noiseReduction: NoiseReduction;
  /** §7 — OpenAI's recommended production starting point for latency. */
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * §5. `0.8` is counterintuitive but recommended: every truncation busts the prompt cache, so
   * trimming aggressively but rarely is much cheaper than trimming minimally but constantly.
   */
  readonly retentionRatio?: number;
  /** `true` errors instead of silently dropping context. Useful in dev to find out you have a problem. */
  readonly truncationDisabled?: boolean;
}

export type FaultKind =
  'auth' | 'offline' | 'session-lost' | 'rate-limited' | 'server-error' | 'protocol';

export interface RealtimeFault {
  readonly kind: FaultKind;
  readonly message: string;
  /** Permission and auth faults do not resolve by retrying (ui-design.md §8). */
  readonly persistent: boolean;
}

/** What `@riki/context`'s tool layer eventually receives, via the composition-root bridge. */
export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  /** A JSON **string**, accumulated from deltas. Parsing and validation are not this package's job. */
  readonly argumentsJson: string;
}

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptEntry {
  readonly itemId: string;
  readonly role: TranscriptRole;
  readonly text: string;
  /** False while deltas are still arriving — captions render partials, the ledger stores finals. */
  readonly final: boolean;
  readonly at: Millis;
}

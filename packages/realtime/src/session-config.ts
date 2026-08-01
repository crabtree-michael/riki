/**
 * The session configuration, and the beta/GA schema trap as a type.
 *
 * A `session.update` carrying a top-level `voice` or a string `input_audio_format` is the beta
 * shape. It does not error — it misconfigures the session, and mixing the two schemas is worse
 * than using either, because a top-level `voice` can cause the GA `audio.*` settings to be
 * discarded entirely (openai-realtime-research.md §3 and the `openai-agents-js` bug it links).
 *
 * Three layers stop it here, in decreasing order of how much they can be trusted:
 *
 * 1. `RealtimeSessionConfig` is our vocabulary. A caller cannot supply `input_audio_format`,
 *    because the type has no such field.
 * 2. `buildSessionUpdate` is the only producer of a wire payload in this package.
 * 3. `assertGaShape` runs on the way out in development and in tests, and the golden snapshot of
 *    its input is how a future SDK bump that reintroduces a legacy field becomes visible.
 *
 * Three layers rather than one because the failure is silent, so we cannot rely on noticing it.
 *
 * See docs/design/voice-input-architecture.md §5.3. Declarations only.
 */

import type { ModelId, VoiceName } from './types.js';

/**
 * ADR-0017. `createResponse` is the literal `false`: the gesture is the only thing that creates a
 * response, and a type that cannot express `true` is how that stays true after the next refactor.
 */
export interface TurnDetectionConfig {
  readonly kind: 'server_vad' | 'semantic_vad' | 'none';
  readonly createResponse: false;
  /** Server-side truncation on barge-in, which is most of why VAD stays on (ADR-0017). */
  readonly interruptResponse: boolean;
  /** Default 200. Sits directly on the release→response path (architecture §5.4). */
  readonly silenceDurationMs: number;
}

/**
 * A separate ASR pass over the input, and therefore an approximation of what was heard rather
 * than a record of it — do not reconstruct model state from it (architecture §6.1). Enabled for
 * the ledger and the local command parser; captions remain off by default (ui-design §9.3).
 */
export interface TranscriptionConfig {
  readonly model: string;
  readonly language: string | null;
}

/**
 * `retentionRatio: 0.8` is counter-intuitive and deliberate: every truncation busts the prompt
 * cache, so trimming aggressively but rarely is much cheaper than trimming minimally and
 * constantly (realtime §5). `disabled` turns the ceiling into an error, which is what development
 * wants and production does not.
 */
export interface TruncationConfig {
  readonly mode: 'auto' | 'disabled';
  readonly retentionRatio: number;
}

export interface ToolManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface RealtimeSessionConfig {
  readonly model: ModelId;
  readonly voice: VoiceName;
  /** The preamble, from `packages/context`. Shares a 16,384-token cap with `tools`. */
  readonly instructions: string;
  /** Frozen for the session (ADR-0011): changing the set mid-session rewrites the cached prefix. */
  readonly tools: readonly ToolManifestEntry[];
  readonly turnDetection: TurnDetectionConfig;
  /** `far_field` for a desk mic, `near_field` for a headset — architecture §3.4. */
  readonly noiseReduction: 'near_field' | 'far_field' | null;
  readonly transcription: TranscriptionConfig | null;
  readonly truncation: TruncationConfig;
}

/** Opaque: the GA-shaped payload. Nothing outside this module constructs one. */
export interface SessionUpdate {
  readonly type: 'session.update';
  readonly session: Readonly<Record<string, unknown>>;
}

export declare function buildSessionUpdate(config: RealtimeSessionConfig): SessionUpdate;

/** Throws on a beta-shaped payload: a top-level `voice`, or a string audio format. */
export declare function assertGaShape(payload: unknown): asserts payload is SessionUpdate;

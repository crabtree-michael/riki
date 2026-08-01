/**
 * The GA wire schema, and the one file that is allowed to know it.
 *
 * openai-realtime-research.md §3 calls the beta→GA mix-up "the single most common integration
 * failure", and the `voice-realtime` skill leads with it. The shape of the trap:
 *
 * ```jsonc
 * // BETA — old tutorials. Still parses. Silently wrong.
 * { "voice": "alloy", "input_audio_format": "pcm16" }
 *
 * // GA — correct
 * { "type": "realtime", "model": "…",
 *   "audio": { "input":  { "format": { "type": "audio/pcm", "rate": 24000 } },
 *              "output": { "format": { "type": "audio/pcm", "rate": 24000 }, "voice": "marin" } } }
 * ```
 *
 * Mixing them is worse than using either: openai-agents-js#495 documents a top-level `voice`
 * causing the GA `audio.*` settings to be **discarded** and the session to fall back to legacy
 * defaults. Nothing errors. The session simply runs misconfigured — wrong voice, and, far worse,
 * a format that does not match the PCM we are sending.
 *
 * Everything here is a pure function returning a plain object, so `ga-schema.test.ts` can assert
 * the payload exactly and snapshot it, which is the guarding test REPO_SKELETON.md §5.4 asks for.
 */

import { REALTIME_SAMPLE_RATE } from './constants.js';
import type { SessionConfig, ToolDefinition } from '../types.js';

/** The GA audio format object. A bare string here is the beta shape. */
export interface GaAudioFormat {
  readonly type: 'audio/pcm';
  readonly rate: number;
}

export const GA_PCM_FORMAT: GaAudioFormat = {
  type: 'audio/pcm',
  rate: REALTIME_SAMPLE_RATE,
};

export interface GaTurnDetection {
  readonly type: 'server_vad' | 'semantic_vad';
  /**
   * The middle ground research §4 describes: keep VAD for speech *detection* so the chip gets
   * `speech_started`/`speech_stopped`, but generate nothing without an explicit `response.create`.
   */
  readonly create_response: boolean;
  readonly interrupt_response: boolean;
}

export interface GaSessionPayload {
  readonly type: 'realtime';
  readonly model: string;
  readonly instructions: string;
  readonly audio: {
    readonly input: {
      readonly format: GaAudioFormat;
      readonly turn_detection: GaTurnDetection | null;
      readonly noise_reduction: { readonly type: 'near_field' | 'far_field' } | null;
    };
    readonly output: {
      readonly format: GaAudioFormat;
      readonly voice: string;
    };
  };
  readonly tools: readonly ToolDefinition[];
  readonly tool_choice: 'auto' | 'none' | 'required';
  readonly max_output_tokens?: number;
  readonly truncation?: 'disabled' | { readonly retention_ratio: number };
  readonly reasoning?: { readonly effort: 'low' | 'medium' | 'high' };
}

export interface SessionUpdateEvent {
  readonly type: 'session.update';
  readonly session: GaSessionPayload;
}

/**
 * Note what is *absent* and must stay absent: no top-level `voice`, no `input_audio_format`, no
 * `output_audio_format`, and no `temperature` — GA removed it (§11.7), on the grounds that low
 * temperature does not make audio deterministic and high temperature produces audible artefacts.
 * Tone is controlled through prompting only.
 */
export function buildSessionUpdate(config: SessionConfig): SessionUpdateEvent {
  const turnDetection: GaTurnDetection | null =
    config.turnDetection === null
      ? null
      : {
          type: config.turnDetection,
          // Riki gates on game state and injects context before the model speaks, so a response
          // is never generated implicitly even when VAD is on (research §4).
          create_response: false,
          interrupt_response: false,
        };

  const session: GaSessionPayload = {
    type: 'realtime',
    model: config.model,
    instructions: config.instructions,
    audio: {
      input: {
        format: GA_PCM_FORMAT,
        turn_detection: turnDetection,
        noise_reduction: config.noiseReduction === null ? null : { type: config.noiseReduction },
      },
      output: {
        format: GA_PCM_FORMAT,
        voice: config.voice,
      },
    },
    tools: config.tools,
    tool_choice: 'auto',
    ...(config.truncationDisabled === true
      ? { truncation: 'disabled' as const }
      : config.retentionRatio === undefined
        ? {}
        : { truncation: { retention_ratio: config.retentionRatio } }),
    ...(config.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: config.reasoningEffort } }),
  };

  return { type: 'session.update', session };
}

// ---------------------------------------------------------------------------------------------
// Client events
// ---------------------------------------------------------------------------------------------

export interface AppendAudioEvent {
  readonly type: 'input_audio_buffer.append';
  /** Base64 PCM16 little-endian at 24 kHz. Encoded by @riki/audio's codec. */
  readonly audio: string;
}

export interface CommitAudioEvent {
  readonly type: 'input_audio_buffer.commit';
}

export interface ClearAudioEvent {
  readonly type: 'input_audio_buffer.clear';
}

export interface CreateResponseEvent {
  readonly type: 'response.create';
  readonly response?: {
    /**
     * `"none"` is the out-of-band mechanism from §11.10 — screening a turn without polluting
     * conversation state.
     */
    readonly conversation?: 'auto' | 'none';
    readonly instructions?: string;
  };
}

export interface CancelResponseEvent {
  readonly type: 'response.cancel';
}

/**
 * The event whose absence corrupts every later turn (§4, and the `voice-realtime` skill).
 * Skipping it leaves the model believing it said things the user never heard.
 */
export interface TruncateItemEvent {
  readonly type: 'conversation.item.truncate';
  readonly item_id: string;
  readonly content_index: number;
  readonly audio_end_ms: number;
}

export interface CreateItemEvent {
  readonly type: 'conversation.item.create';
  readonly item: Readonly<Record<string, unknown>>;
}

export type ClientEvent =
  | SessionUpdateEvent
  | AppendAudioEvent
  | CommitAudioEvent
  | ClearAudioEvent
  | CreateResponseEvent
  | CancelResponseEvent
  | TruncateItemEvent
  | CreateItemEvent;

export function appendAudio(base64: string): AppendAudioEvent {
  return { type: 'input_audio_buffer.append', audio: base64 };
}

export function commitAudio(): CommitAudioEvent {
  return { type: 'input_audio_buffer.commit' };
}

export function clearAudio(): ClearAudioEvent {
  return { type: 'input_audio_buffer.clear' };
}

export function createResponse(): CreateResponseEvent {
  return { type: 'response.create' };
}

export function cancelResponse(): CancelResponseEvent {
  return { type: 'response.cancel' };
}

export function truncateItem(itemId: string, audioEndMs: number): TruncateItemEvent {
  return {
    type: 'conversation.item.truncate',
    item_id: itemId,
    content_index: 0,
    audio_end_ms: Math.max(0, Math.round(audioEndMs)),
  };
}

/** How a tool result gets back into the conversation (agent-command-execution §4.6). */
export function functionCallOutput(callId: string, output: string): CreateItemEvent {
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output },
  };
}

/**
 * Replaces a span of turns with a summary. §5: for long-lived sessions OpenAI's own cookbook
 * pattern is to do this yourself rather than let the API truncate oldest-first, because
 * truncation drops turns outright — it does not summarise or compact.
 */
export function summaryItem(text: string): CreateItemEvent {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text }],
    },
  };
}

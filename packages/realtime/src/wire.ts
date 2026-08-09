/**
 * The narrow slice of the API's event vocabulary this package names.
 *
 * Deliberately partial. The Realtime API has dozens of server events; naming all of them would be
 * a second, worse copy of the vendor's schema that goes stale silently. What is here is what the
 * turn controller, the window executor and the cost meter actually branch on — everything else is
 * carried opaquely and ignored.
 *
 * Nothing outside this package sees these names. `VoiceEvent` in types.ts is what the rest of Riki
 * consumes, and the mapping between the two is the reason the overlay's machine never has to hear
 * the word "conversation.item.truncate" (overlay-architecture.md §5.6).
 *
 * See docs/design/voice-input-architecture.md §5.2.
 */

import type { CallId, ItemId, MonoMs, ResponseId, TokenUsage } from './types.js';
import type { SessionUpdate } from './session-config.js';

export type ClientEvent =
  | SessionUpdate
  | { readonly type: 'input_audio_buffer.commit' }
  | { readonly type: 'input_audio_buffer.clear' }
  | {
      readonly type: 'conversation.item.create';
      readonly item: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'conversation.item.delete'; readonly item_id: ItemId }
  /** The one whose omission corrupts every later turn (realtime §4, architecture §5.5). */
  | {
      readonly type: 'conversation.item.truncate';
      readonly item_id: ItemId;
      readonly content_index: number;
      readonly audio_end_ms: number;
    }
  | { readonly type: 'response.create'; readonly response?: Readonly<Record<string, unknown>> }
  | { readonly type: 'response.cancel' };

export type ServerEvent =
  | { readonly type: 'session.created' | 'session.updated' }
  | { readonly type: 'input_audio_buffer.speech_started' }
  | { readonly type: 'input_audio_buffer.speech_stopped' }
  | { readonly type: 'input_audio_buffer.committed'; readonly item_id: ItemId }
  | {
      readonly type: 'conversation.item.input_audio_transcription.completed';
      readonly item_id: ItemId;
      readonly transcript: string;
    }
  | { readonly type: 'response.created'; readonly response_id: ResponseId }
  | { readonly type: 'response.output_item.added'; readonly item_id: ItemId }
  | {
      readonly type: 'response.output_audio_transcript.done';
      readonly item_id: ItemId;
      readonly transcript: string;
    }
  /**
   * The model asking the world a question, mid-answer (ADR-0042).
   *
   * All three fields are load-bearing now that this is dispatched rather than counted: `call_id`
   * is what the `function_call_output` is addressed to, and an answer sent without it lands
   * nowhere; `arguments` is the raw JSON string the API sends, validated by `parseToolCall`
   * against the same schema the model was shown.
   */
  | {
      readonly type: 'response.function_call_arguments.done';
      readonly call_id: CallId;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: 'response.done';
      readonly response_id: ResponseId;
      readonly usage: TokenUsage | null;
    }
  | { readonly type: 'rate_limits.updated' }
  | { readonly type: 'error'; readonly code: string; readonly message: string }
  /** Anything we do not branch on. Carried, counted, and not interpreted. */
  | { readonly type: 'unhandled'; readonly raw: Readonly<Record<string, unknown>> };

// -----------------------------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------------------------

/**
 * Beta event names that mean something we care about.
 *
 * These are the *quiet* half of the schema trap. Code written against the GA names simply never
 * fires when the session was configured with the beta schema — so Riki listens, thinks, and stays
 * silent forever, with no error anywhere. Mapping them to an `error` event is what turns that into
 * something a developer can see (realtime §3).
 */
export const BETA_EVENT_ALIASES: ReadonlySet<string> = new Set([
  'response.audio.delta',
  'response.audio.done',
  'response.audio_transcript.delta',
  'response.audio_transcript.done',
]);

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * `usage` as the API reports it, flattened into our `TokenUsage`.
 *
 * Cached input is pulled out separately because at an 80× discount it is the only number in the
 * bill that matters (realtime §10). A turn whose usage we cannot read reports `null` rather than
 * an estimate — `cost.ts` records only real usage, and an estimated turn there is worse than a
 * missing one.
 */
function readUsage(raw: unknown, at: MonoMs): TokenUsage | null {
  const usage = record(raw);
  if (!usage) return null;

  const input = record(usage.input_token_details);
  const output = record(usage.output_token_details);
  const inputAudio = num(input?.audio_tokens) ?? 0;
  const inputText = num(input?.text_tokens) ?? 0;
  const outputText = num(output?.text_tokens) ?? 0;

  return {
    inputAudioTokens: inputAudio,
    cachedInputTokens: num(input?.cached_tokens) ?? 0,
    outputAudioTokens: num(output?.audio_tokens) ?? 0,
    textTokens: inputText + outputText,
    at,
  };
}

/**
 * One raw frame in, one `ServerEvent` out. Never throws, and never returns nothing.
 *
 * Anything we do not branch on becomes `unhandled` rather than an error. The API gains events
 * without a version bump, and a session that dies because OpenAI shipped a new notification is a
 * worse failure than one that carries it and moves on.
 */
export function parseServerEvent(raw: unknown, at: MonoMs): ServerEvent {
  const event = record(raw);
  const type = str(event?.type);
  if (!event || type === null) {
    return { type: 'unhandled', raw: event ?? {} };
  }

  if (BETA_EVENT_ALIASES.has(type)) {
    return {
      type: 'error',
      code: 'beta-schema',
      message: `Received the beta event "${type}". The session was configured with the beta schema; see openai-realtime-research.md §3.`,
    };
  }

  switch (type) {
    case 'session.created':
    case 'session.updated':
      return { type };

    case 'input_audio_buffer.speech_started':
    case 'input_audio_buffer.speech_stopped':
    case 'rate_limits.updated':
      return { type };

    case 'input_audio_buffer.committed':
      return { type, item_id: (str(event.item_id) ?? '') as ItemId };

    case 'conversation.item.input_audio_transcription.completed':
      return {
        type,
        item_id: (str(event.item_id) ?? '') as ItemId,
        transcript: str(event.transcript) ?? '',
      };

    case 'response.created':
      return {
        type,
        response_id: (str(event.response_id) ??
          str(record(event.response)?.id) ??
          '') as ResponseId,
      };

    case 'response.output_item.added':
      return {
        type,
        item_id: (str(event.item_id) ?? str(record(event.item)?.id) ?? '') as ItemId,
      };

    case 'response.output_audio_transcript.done':
      return {
        type,
        item_id: (str(event.item_id) ?? '') as ItemId,
        transcript: str(event.transcript) ?? '',
      };

    case 'response.function_call_arguments.done':
      // Was a name and nothing else, on the grounds that a session sending `tools: []` has no
      // result to submit and the arguments to a tool that does not exist are not information.
      // ADR-0042 reversed both halves of that.
      //
      // Missing fields become `''` rather than throwing, as everywhere else in this parser — and
      // the empty `call_id` is *acted on* rather than passed through: `session.ts` refuses to
      // dispatch a call it could not answer, which is the lesson of the empty `sessionId` that
      // failed four layers away as silence (voice-realtime skill, 2026-08-04).
      return {
        type,
        call_id: (str(event.call_id) ?? '') as CallId,
        name: str(event.name) ?? '',
        arguments: str(event.arguments) ?? '',
      };

    case 'response.done': {
      const response = record(event.response);
      return {
        type,
        response_id: (str(event.response_id) ?? str(response?.id) ?? '') as ResponseId,
        usage: readUsage(response?.usage ?? event.usage, at),
      };
    }

    case 'error': {
      const error = record(event.error);
      return {
        type,
        code: str(error?.code) ?? str(event.code) ?? 'unknown',
        message: str(error?.message) ?? str(event.message) ?? 'The session reported an error.',
      };
    }

    default:
      return { type: 'unhandled', raw: event };
  }
}

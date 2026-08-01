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
 * See docs/design/voice-input-architecture.md §5.2. Declarations only.
 */

import type { CallId, ItemId, ResponseId, TokenUsage } from './types.js';
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

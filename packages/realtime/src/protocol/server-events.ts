/**
 * Server events, and the narrow gate everything from the wire passes through.
 *
 * Two rules hold here and nowhere else in the package:
 *
 * 1. **Unknown event types are ignored, not errors.** The API gains events without a version
 *    bump; a session that dies because OpenAI shipped a new notification is a worse failure than
 *    one that ignores it. Only *malformed* known events are faults.
 * 2. **The GA names are the only names.** Beta used `response.audio.delta` and
 *    `response.audio_transcript.delta`; GA uses `response.output_audio.delta` and
 *    `response.output_audio_transcript.delta`. Code written against the beta names does not
 *    error — it simply never fires, so Riki listens, thinks, and stays silent. `KNOWN_BETA_ALIASES`
 *    exists so that failure is loud instead.
 */

export interface ServerEventEnvelope {
  readonly type: string;
  readonly event_id?: string;
  readonly [key: string]: unknown;
}

export type ServerEvent =
  | { readonly kind: 'session.created'; readonly sessionId: string }
  | { readonly kind: 'session.updated' }
  | { readonly kind: 'speech.started' }
  | { readonly kind: 'speech.stopped' }
  | { readonly kind: 'audio.committed'; readonly itemId: string }
  | { readonly kind: 'response.created'; readonly responseId: string }
  | {
      readonly kind: 'response.done';
      readonly responseId: string;
      readonly usage: UsageReport | null;
    }
  /** The assistant's audio. On WebRTC this rides the media track and only `done` is seen. */
  | { readonly kind: 'audio.delta'; readonly itemId: string; readonly bytes: number }
  | { readonly kind: 'audio.done'; readonly itemId: string; readonly durationMs: number | null }
  | {
      readonly kind: 'transcript.delta';
      readonly itemId: string;
      readonly role: 'user' | 'assistant';
      readonly text: string;
    }
  | {
      readonly kind: 'transcript.done';
      readonly itemId: string;
      readonly role: 'user' | 'assistant';
      readonly text: string;
    }
  | {
      readonly kind: 'tool.delta';
      readonly callId: string;
      readonly name: string | null;
      readonly delta: string;
    }
  | { readonly kind: 'tool.done'; readonly callId: string; readonly argumentsJson: string }
  | { readonly kind: 'rate-limits'; readonly remainingTokens: number | null }
  | { readonly kind: 'error'; readonly code: string | null; readonly message: string };

export interface UsageReport {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputAudioTokens: number;
  readonly outputAudioTokens: number;
}

/**
 * Beta names that mean something we care about. Seeing one means the session was configured with
 * the beta schema — the exact failure openai-realtime-research.md §3 warns about — so it is
 * surfaced as a protocol fault rather than dropped as unknown.
 */
export const KNOWN_BETA_ALIASES: ReadonlySet<string> = new Set([
  'response.audio.delta',
  'response.audio.done',
  'response.audio_transcript.delta',
  'response.audio_transcript.done',
]);

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readUsage(raw: unknown): UsageReport | null {
  const response = asRecord(raw);
  const usage = asRecord(response?.usage);
  if (!usage) return null;

  const inputDetails = asRecord(usage.input_token_details);
  const outputDetails = asRecord(usage.output_token_details);
  const cachedDetails = asRecord(inputDetails?.cached_tokens_details);

  return {
    inputTokens: asNumber(usage.input_tokens) ?? 0,
    outputTokens: asNumber(usage.output_tokens) ?? 0,
    cachedInputTokens:
      asNumber(inputDetails?.cached_tokens) ?? asNumber(cachedDetails?.audio_tokens) ?? 0,
    inputAudioTokens: asNumber(inputDetails?.audio_tokens) ?? 0,
    outputAudioTokens: asNumber(outputDetails?.audio_tokens) ?? 0,
  };
}

/**
 * Returns `null` for anything we do not act on. That covers genuinely unknown events and the
 * several known-but-uninteresting ones (`response.output_item.added`, `conversation.item.created`)
 * that would otherwise need a case each to stay silent.
 */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  const event = asRecord(raw);
  const type = asString(event?.type);
  if (!event || type === null) return null;

  if (KNOWN_BETA_ALIASES.has(type)) {
    return {
      kind: 'error',
      code: 'beta-schema',
      message: `Received the beta event "${type}". The session was configured with the beta schema; see openai-realtime-research.md §3.`,
    };
  }

  switch (type) {
    case 'session.created':
      return {
        kind: 'session.created',
        sessionId: asString(asRecord(event.session)?.id) ?? 'unknown',
      };

    case 'session.updated':
      return { kind: 'session.updated' };

    case 'input_audio_buffer.speech_started':
      return { kind: 'speech.started' };

    case 'input_audio_buffer.speech_stopped':
      return { kind: 'speech.stopped' };

    case 'input_audio_buffer.committed':
      return { kind: 'audio.committed', itemId: asString(event.item_id) ?? '' };

    case 'response.created':
      return {
        kind: 'response.created',
        responseId: asString(asRecord(event.response)?.id) ?? '',
      };

    case 'response.done':
      return {
        kind: 'response.done',
        responseId: asString(asRecord(event.response)?.id) ?? '',
        usage: readUsage(event.response),
      };

    case 'response.output_audio.delta': {
      const delta = asString(event.delta) ?? '';
      return {
        kind: 'audio.delta',
        itemId: asString(event.item_id) ?? '',
        // Base64 is 4 characters per 3 bytes. Only the size matters here — the samples ride the
        // media track on WebRTC, and this is used purely for playback accounting.
        bytes: Math.floor((delta.length * 3) / 4),
      };
    }

    case 'response.output_audio.done':
      return {
        kind: 'audio.done',
        itemId: asString(event.item_id) ?? '',
        durationMs: asNumber(event.audio_end_ms),
      };

    case 'response.output_audio_transcript.delta':
      return {
        kind: 'transcript.delta',
        itemId: asString(event.item_id) ?? '',
        role: 'assistant',
        text: asString(event.delta) ?? '',
      };

    case 'response.output_audio_transcript.done':
      return {
        kind: 'transcript.done',
        itemId: asString(event.item_id) ?? '',
        role: 'assistant',
        text: asString(event.transcript) ?? '',
      };

    case 'conversation.item.input_audio_transcription.delta':
      return {
        kind: 'transcript.delta',
        itemId: asString(event.item_id) ?? '',
        role: 'user',
        text: asString(event.delta) ?? '',
      };

    case 'conversation.item.input_audio_transcription.completed':
      return {
        kind: 'transcript.done',
        itemId: asString(event.item_id) ?? '',
        role: 'user',
        text: asString(event.transcript) ?? '',
      };

    case 'conversation.item.input_audio_transcription.failed':
      return {
        kind: 'error',
        code: 'transcription-failed',
        message: asString(asRecord(event.error)?.message) ?? 'Transcription failed.',
      };

    case 'response.function_call_arguments.delta':
      return {
        kind: 'tool.delta',
        callId: asString(event.call_id) ?? '',
        name: asString(event.name),
        delta: asString(event.delta) ?? '',
      };

    case 'response.function_call_arguments.done':
      return {
        kind: 'tool.done',
        callId: asString(event.call_id) ?? '',
        argumentsJson: asString(event.arguments) ?? '',
      };

    case 'rate_limits.updated': {
      const limits: readonly unknown[] = Array.isArray(event.rate_limits)
        ? (event.rate_limits as readonly unknown[])
        : [];
      const tokens = limits.find((entry) => asString(asRecord(entry)?.name) === 'tokens');
      return { kind: 'rate-limits', remainingTokens: asNumber(asRecord(tokens)?.remaining) };
    }

    case 'error': {
      const error = asRecord(event.error);
      return {
        kind: 'error',
        code: asString(error?.code),
        message: asString(error?.message) ?? 'The Realtime session reported an error.',
      };
    }

    default:
      return null;
  }
}

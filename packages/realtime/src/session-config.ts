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
 * See docs/design/voice-input-architecture.md §5.3.
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

/** PCM only supports 24 kHz (realtime §3), so this is a constant rather than a setting. */
export const REALTIME_SAMPLE_RATE = 24_000;

/** The GA format object. A bare `"pcm16"` string in its place is the beta shape. */
const GA_PCM_FORMAT = { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE } as const;

/**
 * The only producer of a wire payload in this package (layer 2 of the three above).
 *
 * Note what is deliberately absent and must stay absent: no top-level `voice`, no
 * `input_audio_format` / `output_audio_format`, no `modalities`, and no `temperature` — GA removed
 * it, on the grounds that low temperature does not make audio deterministic and high temperature
 * produces audible artefacts (realtime §11.7). Tone is controlled through prompting only.
 */
export function buildSessionUpdate(config: RealtimeSessionConfig): SessionUpdate {
  const detection = config.turnDetection;

  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: config.model,
      instructions: config.instructions,
      audio: {
        input: {
          format: GA_PCM_FORMAT,
          // ADR-0017: VAD stays on so server-side barge-in truncation keeps working, and
          // `create_response` is always false so the gesture remains the sole authority over when
          // a response is generated.
          turn_detection:
            detection.kind === 'none'
              ? null
              : {
                  type: detection.kind,
                  create_response: detection.createResponse,
                  interrupt_response: detection.interruptResponse,
                  silence_duration_ms: detection.silenceDurationMs,
                },
          noise_reduction: config.noiseReduction === null ? null : { type: config.noiseReduction },
          transcription:
            config.transcription === null
              ? null
              : {
                  model: config.transcription.model,
                  ...(config.transcription.language === null
                    ? {}
                    : { language: config.transcription.language }),
                },
        },
        output: {
          format: GA_PCM_FORMAT,
          voice: config.voice,
        },
      },
      tools: config.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      tool_choice: 'auto',
      truncation:
        config.truncation.mode === 'disabled'
          ? 'disabled'
          : { retention_ratio: config.truncation.retentionRatio },
    },
  };
}

/** Beta field names, at any depth. Their presence means the two schemas have been mixed. */
const BETA_KEYS: readonly string[] = [
  'input_audio_format',
  'output_audio_format',
  'modalities',
  'temperature',
];

function findBetaKey(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findBetaKey(entry, `${path}[${String(index)}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;

  for (const [key, entry] of Object.entries(value)) {
    if (BETA_KEYS.includes(key)) return `${path}.${key}`;
    const found = findBetaKey(entry, `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Throws on a beta-shaped payload: a top-level `voice`, or a string audio format.
 *
 * Layer 3, and the one that catches what the type system cannot — an SDK bump or a hand-edited
 * payload that reintroduces a legacy field. Cheap enough to run on every outgoing
 * `session.update`, which is the point: the failure it guards is silent, so we cannot rely on
 * noticing it.
 */
export function assertGaShape(payload: unknown): asserts payload is SessionUpdate {
  if (typeof payload !== 'object' || payload === null) {
    throw new TypeError('session.update payload is not an object.');
  }
  const envelope = payload as Record<string, unknown>;
  if (envelope.type !== 'session.update') {
    throw new TypeError('session.update payload has the wrong envelope type.');
  }

  const session = envelope.session;
  if (typeof session !== 'object' || session === null) {
    throw new TypeError('session.update carries no session object.');
  }
  const record = session as Record<string, unknown>;

  // The single most damaging one: openai-agents-js#495 documents a top-level `voice` causing the
  // GA `audio.*` settings to be discarded entirely and the session to fall back to legacy
  // defaults. Nothing errors; the session just runs misconfigured.
  if ('voice' in record) {
    throw new TypeError(
      'session.update carries a top-level `voice` — that is the beta schema, and it causes the GA audio settings to be discarded (realtime §3).',
    );
  }

  const betaKey = findBetaKey(session, 'session');
  if (betaKey !== null) {
    throw new TypeError(`session.update carries the beta field \`${betaKey}\` (realtime §3).`);
  }

  const audio = record.audio;
  if (typeof audio !== 'object' || audio === null) {
    throw new TypeError('session.update carries no `audio` block — that is the beta schema.');
  }
  for (const leg of ['input', 'output'] as const) {
    const format = (((audio as Record<string, unknown>)[leg] ?? {}) as Record<string, unknown>)
      .format;
    if (typeof format === 'string') {
      throw new TypeError(
        `session.update carries a string \`audio.${leg}.format\` — the GA shape is an object (realtime §3).`,
      );
    }
  }
}

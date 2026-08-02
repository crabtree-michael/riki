/**
 * The committed defaults, the coercions, and the one error that names the offending key.
 *
 * REPO_SKELETON.md §7: *"Invalid config fails at startup with a readable message naming the
 * offending key. It never half-boots — a Riki that runs with a broken microphone setting and no
 * error is exactly the failure `ui-design.md` §1.6 says to avoid."* That sentence is this file.
 *
 * ## Why coercion is here and not in `sources.ts`
 *
 * An environment variable is always a string; a `settings.json` field may already be a number or
 * a boolean; a CLI flag is a string again. If each source coerced its own values there would be
 * three answers to what `"off"` means and three places producing an error message. The sources
 * hand over raw values and this file decides, once.
 *
 * ## The defaults are the product's privacy posture
 *
 * `DEFAULTS.privacy` is all `false`, and REPO_SKELETON.md §7.2 rule 2 requires it to stay that
 * way: captions off, unprompted speech off, chat egress off, debug frame capture off. `schema.test.ts`
 * asserts each one separately, because a privacy default that is only written down is a privacy
 * default that will drift.
 */

import { z } from 'zod';
import { DEFAULT_GSI_PORT } from '@riki/gsi';
import { DEFAULT_BUDGET_USD } from '@riki/realtime';
import type { ModelId, VoiceName } from '@riki/realtime';

import { describeKey } from './keys.js';
import type { ConfigKey } from './keys.js';
import type { ConfigLayer } from './sources.js';
import type { LogLevel, RikiConfig, TransportKind } from './types.js';

// -----------------------------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------------------------

/**
 * The bottom layer. Everything a developer with an empty `.env` and no `settings.json` gets.
 *
 * Two of these disagree with the block quoted in REPO_SKELETON.md §7.2, and both disagreements are
 * deliberate:
 *
 * - **`vision.enabled` is off**, where the quoted example says `RIKI_VISION=on`. No platform
 *   backend can capture yet ([ADR-0030](../../../docs/adr/0030-the-capture-seam-returns-cropped-regions-never-frames.md)),
 *   so `on` would mean every launch spends ten supervisor restarts discovering that the sidecar
 *   exits immediately. `.env.example` has been corrected to match.
 * - **`gsi.port`** comes from `@riki/gsi` rather than being written here, because it has to equal
 *   the number `tools/setup-gsi-cfg` writes into Dota's cfg. Two copies of that number is a 403
 *   that looks exactly like a misconfigured game.
 */
export const DEFAULTS = {
  realtime: {
    // The mini model is the cost lever and the reason it is the default (realtime research §10).
    model: 'gpt-realtime-2.1-mini' as ModelId,
    voice: 'marin' as VoiceName,
    transport: 'webrtc' as TransportKind,
    budgetUsd: DEFAULT_BUDGET_USD,
  },
  audio: {
    inputDeviceId: null,
    /**
     * `packages/audio`'s `DEFAULT_CAPTURE_OPTIONS.preRollMs`, restated rather than imported.
     * The composition root passes this value into `createCaptureGraph` explicitly, so the
     * constant over there is never the one in force — which is what stops the two drifting into
     * a difference nobody can observe.
     */
    preRollMs: 200,
  },
  gsi: { port: DEFAULT_GSI_PORT },
  dotaPath: null,
  vision: { enabled: false, binaryPath: null, fake: false },
  logTail: { path: null, pollMs: 250 },
  hotkey: { talk: 'Control+`' },
  privacy: { captions: false, unprompted: false, chatEgress: false, debugFrames: false },
  logLevel: 'info' as LogLevel,
  replayFixture: null,
} as const;

// -----------------------------------------------------------------------------------------------
// Coercions
// -----------------------------------------------------------------------------------------------

const TRUE_WORDS = new Set(['on', 'true', '1', 'yes']);
const FALSE_WORDS = new Set(['off', 'false', '0', 'no']);

/** `on` / `off`, and the four other spellings `.env` files use in practice. */
const flag = z.union([z.boolean(), z.string()]).transform((value, ctx): boolean => {
  if (typeof value === 'boolean') return value;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  ctx.addIssue({ code: 'custom', message: `expected on or off, got ${JSON.stringify(value)}` });
  return z.NEVER;
});

const integer = (min: number, max: number): z.ZodType<number> =>
  z.union([z.number(), z.string()]).transform((value, ctx): number => {
    const parsed = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      ctx.addIssue({
        code: 'custom',
        message: `expected a whole number between ${String(min)} and ${String(max)}, got ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
    return parsed;
  });

const positiveNumber = z.union([z.number(), z.string()]).transform((value, ctx): number => {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    ctx.addIssue({
      code: 'custom',
      message: `expected a positive number, got ${JSON.stringify(value)}`,
    });
    return z.NEVER;
  }
  return parsed;
});

const text = z.string().min(1);

/** A path or an id where blank means "unset", so `.env.example` can ship the variable empty. */
const optionalText = z
  .union([z.string(), z.null()])
  .transform((value): string | null => (value === null || value.trim() === '' ? null : value));

/**
 * A closed set, kept exhaustive by `Record<T, true>` rather than by a list somebody remembers to
 * update: a new `VoiceName` in `@riki/realtime` is a type error here, not a value that silently
 * fails validation at startup.
 */
function oneOf<T extends string>(table: Readonly<Record<T, true>>): z.ZodType<T> {
  const names = Object.keys(table);
  return z.string().transform((value, ctx): T => {
    if (Object.prototype.hasOwnProperty.call(table, value)) return value as T;
    ctx.addIssue({
      code: 'custom',
      message: `expected one of ${names.join(', ')}, got ${JSON.stringify(value)}`,
    });
    return z.NEVER;
  });
}

const MODELS: Record<ModelId, true> = {
  'gpt-realtime-2.1': true,
  'gpt-realtime-2.1-mini': true,
};

const VOICES: Record<VoiceName, true> = {
  alloy: true,
  ash: true,
  ballad: true,
  cedar: true,
  coral: true,
  echo: true,
  marin: true,
  sage: true,
  shimmer: true,
  verse: true,
};

const TRANSPORTS: Record<TransportKind, true> = { webrtc: true, websocket: true };

const LOG_LEVELS: Record<LogLevel, true> = {
  error: true,
  warn: true,
  info: true,
  debug: true,
  trace: true,
};

// -----------------------------------------------------------------------------------------------
// The schema
// -----------------------------------------------------------------------------------------------

/**
 * Everything except the API key and `dataDir`.
 *
 * The key is not here because it is not a layered setting and never reaches a schema — `env.ts`
 * explains why. `dataDir` is not here because it is not a *setting*: it is where the caller has
 * decided the app's files live, and validating it would be validating Electron.
 */
const SETTINGS_SCHEMA = z.object({
  realtime: z.object({
    model: oneOf(MODELS),
    voice: oneOf(VOICES),
    transport: oneOf(TRANSPORTS),
    budgetUsd: positiveNumber,
  }),
  audio: z.object({
    inputDeviceId: optionalText,
    preRollMs: integer(0, 2_000),
  }),
  gsi: z.object({
    port: integer(1, 65_535),
    token: text,
  }),
  dotaPath: optionalText,
  vision: z.object({
    enabled: flag,
    binaryPath: optionalText,
    fake: flag,
  }),
  logTail: z.object({
    path: optionalText,
    pollMs: integer(10, 60_000),
  }),
  hotkey: z.object({ talk: text }),
  privacy: z.object({
    captions: flag,
    unprompted: flag,
    chatEgress: flag,
    debugFrames: flag,
  }),
  logLevel: oneOf(LOG_LEVELS),
  replayFixture: optionalText,
});

// -----------------------------------------------------------------------------------------------
// The error
// -----------------------------------------------------------------------------------------------

export interface ConfigIssue {
  /** The dotted path, e.g. `gsi.port`. */
  readonly key: string;
  readonly message: string;
}

/**
 * Startup refused, with every bad key named.
 *
 * Every issue rather than the first: a developer who mistyped two variables should fix both in one
 * pass rather than discover the second after a restart.
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const lines = issues.map((issue) => `  ${describeKey(issue.key)}: ${issue.message}`);
    super(
      `Riki cannot start: ${String(issues.length)} setting${issues.length === 1 ? ' is' : 's are'} invalid.\n` +
        `${lines.join('\n')}\n` +
        'See .env.example and REPO_SKELETON.md §7.',
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// -----------------------------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------------------------

export interface ResolveInput {
  /** Highest wins, so the caller passes flags, then environment, then the user config file. */
  readonly layer: ConfigLayer;
  /** Not a setting: where the caller has decided the app's files live. */
  readonly dataDir: string;
  /**
   * The per-install GSI token, generated and persisted by the caller. `RIKI_GSI_TOKEN` overrides
   * it; there is no default, because a token that changed between launches would mean every POST
   * after the first was refused with a 403 that looks exactly like a misconfigured cfg.
   */
  readonly gsiToken: string;
  /** Already an `ApiKey` or already absent. It does not pass through validation — see `env.ts`. */
  readonly apiKey: RikiConfig['openai']['apiKey'];
}

/**
 * The merged layer plus the defaults, validated. Pure: every I/O this needs has been done.
 *
 * @throws ConfigError naming every offending key.
 */
export function resolveConfig(input: ResolveInput): RikiConfig {
  const { layer } = input;
  const pick = (key: ConfigKey, fallback: unknown): unknown =>
    key in layer ? layer[key] : fallback;

  const raw = {
    realtime: {
      model: pick('realtime.model', DEFAULTS.realtime.model),
      voice: pick('realtime.voice', DEFAULTS.realtime.voice),
      transport: pick('realtime.transport', DEFAULTS.realtime.transport),
      budgetUsd: pick('realtime.budgetUsd', DEFAULTS.realtime.budgetUsd),
    },
    audio: {
      inputDeviceId: pick('audio.inputDeviceId', DEFAULTS.audio.inputDeviceId),
      preRollMs: pick('audio.preRollMs', DEFAULTS.audio.preRollMs),
    },
    gsi: {
      port: pick('gsi.port', DEFAULTS.gsi.port),
      token: pick('gsi.token', input.gsiToken),
    },
    dotaPath: pick('dotaPath', DEFAULTS.dotaPath),
    vision: {
      enabled: pick('vision.enabled', DEFAULTS.vision.enabled),
      binaryPath: pick('vision.binaryPath', DEFAULTS.vision.binaryPath),
      fake: pick('vision.fake', DEFAULTS.vision.fake),
    },
    logTail: {
      path: pick('logTail.path', DEFAULTS.logTail.path),
      pollMs: pick('logTail.pollMs', DEFAULTS.logTail.pollMs),
    },
    hotkey: { talk: pick('hotkey.talk', DEFAULTS.hotkey.talk) },
    privacy: {
      captions: pick('privacy.captions', DEFAULTS.privacy.captions),
      unprompted: pick('privacy.unprompted', DEFAULTS.privacy.unprompted),
      chatEgress: pick('privacy.chatEgress', DEFAULTS.privacy.chatEgress),
      debugFrames: pick('privacy.debugFrames', DEFAULTS.privacy.debugFrames),
    },
    logLevel: pick('logLevel', DEFAULTS.logLevel),
    replayFixture: pick('replayFixture', DEFAULTS.replayFixture),
  };

  const result = SETTINGS_SCHEMA.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        key: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  return { ...result.data, openai: { apiKey: input.apiKey }, dataDir: input.dataDir };
}

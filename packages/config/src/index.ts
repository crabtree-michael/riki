/**
 * @riki/config
 *
 * Resolves configuration once at startup and hands it out by injection thereafter.
 *
 * Layered, highest wins: CLI flags → environment → user config file → committed defaults.
 * Validated with zod; invalid config fails at startup with a message naming the offending key
 * rather than half-booting.
 *
 * This is the only module in the repo permitted to read `process.env` — a lint rule enforces
 * it (§6.2). That is what keeps RIKI_OPENAI_API_KEY (§7.1) traceable to one auditable file, and
 * what makes replacing the env-var scheme at distribution time a one-file change.
 *
 * ## The shape of it
 *
 * `env.ts` is the entire environment surface and is nine lines long. Everything else — the `.env`
 * parser, the flag parser, the `settings.json` flattener, the coercions, the defaults — is a pure
 * function, so which layer wins is a Tier 1 test with no disk and no environment. `load.ts` is the
 * only file that does I/O and it is the only one the composition root calls.
 *
 * ## Two things that are not layered settings
 *
 * **`RIKI_OPENAI_API_KEY`** has no row in `keys.ts`, so it cannot arrive from a CLI flag or from
 * `settings.json` — only from the environment, and it goes into the `ApiKey` constructor in the
 * expression that reads it (ADR-0022). Absent is a supported mode: the app boots with voice
 * disabled and says so (ADR-0006). Present-but-malformed fails at startup naming the variable and
 * never carrying the value.
 *
 * **`dataDir` and `gsiToken`** are inputs rather than settings. The first is where the caller has
 * decided the app's files live; the second is generated per install and persisted by the caller,
 * because a token that changed between launches would be a 403 that looks exactly like a
 * misconfigured cfg.
 */

export type * from './types.js';
export { voiceEnabled } from './types.js';

export { CONFIG_KEYS, BOOLEAN_KEYS, flagNameFor, describeKey } from './keys.js';
export type { ConfigKey } from './keys.js';

export {
  parseDotenv,
  parseFlags,
  fromEnv,
  fromSettings,
  mergeLayers,
  UnknownSettingError,
} from './sources.js';
export type { ConfigLayer, EnvRecord } from './sources.js';

export { DEFAULTS, ConfigError, resolveConfig } from './schema.js';
export type { ConfigIssue, ResolveInput } from './schema.js';

export { API_KEY_VAR, readApiKey, readProcessEnv } from './env.js';

export {
  ENV_FILE,
  ENV_SEARCH_DEPTH,
  SETTINGS_FILE,
  envFilePath,
  findEnvFile,
  loadConfig,
  nodeFileSystem,
} from './load.js';
export type { ConfigFileSystem, LoadConfigInput } from './load.js';

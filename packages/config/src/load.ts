/**
 * The impure entry: gather the layers off the machine, then hand them to the pure resolver.
 *
 * Everything I/O-shaped is behind `ConfigFileSystem` and `EnvRecord`, so `load.test.ts` drives the
 * whole of startup — a `.env`, a `settings.json`, an argv and an environment — without touching a
 * disk. That matters more here than usual: the behaviour worth testing is which layer wins, and
 * that is invisible in any test that can only supply one of them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readApiKey, readProcessEnv } from './env.js';
import { fromEnv, fromSettings, mergeLayers, parseDotenv, parseFlags } from './sources.js';
import type { ConfigLayer, EnvRecord } from './sources.js';
import { resolveConfig } from './schema.js';
import type { RikiConfig } from './types.js';

export const ENV_FILE = '.env';
export const SETTINGS_FILE = 'settings.json';

/** How far up from the working directory to look for `.env`. */
export const ENV_SEARCH_DEPTH = 4;

/** Injected so startup is testable. `null` is "no such file", not an error. */
export interface ConfigFileSystem {
  readText(path: string): string | null;
}

export const nodeFileSystem: ConfigFileSystem = {
  readText(path: string): string | null {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

export interface LoadConfigInput {
  /** Where the app's files live. `app.getPath('userData')` in production. */
  readonly dataDir: string;
  /** The per-install GSI token. The caller generates and persists it; this package does not. */
  readonly gsiToken: string;
  /** Electron's own switches are on this argv too; unrecognised ones are ignored. */
  readonly argv?: readonly string[];
  /** Where the search for `.env` starts. Defaults to the process working directory. */
  readonly cwd?: string;
  readonly env?: EnvRecord;
  readonly fs?: ConfigFileSystem;
}

/**
 * `.env`, searched upward from the working directory.
 *
 * Upward because `pnpm dev` runs Electron from `apps/desktop` while the developer's `.env` is at
 * the repo root, which is where `pnpm setup` and `.env.example` put it. A packaged app has no
 * `.env` at all and every candidate misses, which is the intended outcome rather than a fallback.
 */
export function findEnvFile(
  fs: ConfigFileSystem,
  cwd: string,
): { path: string; text: string } | null {
  let dir = resolve(cwd);
  for (let depth = 0; depth < ENV_SEARCH_DEPTH; depth += 1) {
    const path = join(dir, ENV_FILE);
    const text = fs.readText(path);
    if (text !== null) return { path, text };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The real environment wins over `.env`, which is what every dotenv implementation does and what a
 * developer running `RIKI_LOG_LEVEL=debug pnpm dev` expects. A variable set to the empty string
 * does not win — `.env.example` ships several of those blank and copying it unchanged must not
 * blank out a value the shell supplied.
 */
function overlayEnv(base: Record<string, string>, over: EnvRecord): EnvRecord {
  const out: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(over)) {
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

function readSettings(fs: ConfigFileSystem, dataDir: string): unknown {
  const text = fs.readText(join(dataDir, SETTINGS_FILE));
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (cause) {
    // Total in `bootstrap.ts`'s old stand-in, loud here: a settings file the app cannot read is a
    // set of settings that silently do nothing, which is the failure §7 exists to prevent.
    throw new Error(`${join(dataDir, SETTINGS_FILE)} is not valid JSON.`, { cause });
  }
}

/**
 * Resolve configuration once, at startup.
 *
 * @throws ConfigError naming every invalid key, `UnknownSettingError` for a typo in
 *   `settings.json`, or an `Error` naming `RIKI_OPENAI_API_KEY` when it is present but malformed.
 */
export function loadConfig(input: LoadConfigInput): RikiConfig {
  const fs = input.fs ?? nodeFileSystem;
  const cwd = input.cwd ?? process.cwd();
  const processEnv = input.env ?? readProcessEnv();

  const dotenv = findEnvFile(fs, cwd);
  const env = overlayEnv(dotenv === null ? {} : parseDotenv(dotenv.text), processEnv);

  const layers: ConfigLayer[] = [
    parseFlags(input.argv ?? []),
    fromEnv(env),
    fromSettings(readSettings(fs, input.dataDir)),
  ];

  return resolveConfig({
    layer: mergeLayers(...layers),
    dataDir: input.dataDir,
    gsiToken: input.gsiToken,
    // Read from the merged environment and wrapped in the same expression — ADR-0022.
    apiKey: readApiKey(env),
  });
}

/** Where `loadConfig` would look for `.env`, for a startup log line that has to be actionable. */
export function envFilePath(fs: ConfigFileSystem, cwd: string): string | null {
  const found = findEnvFile(fs, cwd);
  return found === null ? null : found.path;
}

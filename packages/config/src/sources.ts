/**
 * Turning each layer into the same shape: a flat map of dotted key → raw value.
 *
 * Everything here is a pure function of its input, which is the reason the layering is testable at
 * all — `load.ts` does the I/O and calls these, and a test drives them with three literals.
 *
 * Raw values stay raw. An environment variable is a string, a `settings.json` field may already be
 * a number or a boolean, and neither is coerced here: `schema.ts` owns coercion so there is one
 * place that decides what `"off"` means, and one place that produces the error naming the key.
 */

import type { ConfigKey } from './keys.js';
import { BOOLEAN_KEYS, CONFIG_KEYS, CONFIG_KEY_LIST, keyForFlag } from './keys.js';

/** One layer. Absent means "this layer has no opinion", which is not the same as null. */
export type ConfigLayer = Partial<Record<ConfigKey, unknown>>;

// -----------------------------------------------------------------------------------------------
// `.env`
// -----------------------------------------------------------------------------------------------

/**
 * A deliberately small `.env` parser: `KEY=value`, `#` comments, optional quotes.
 *
 * Small because the alternative is a dependency that runs at startup in the main process and can
 * see every variable in the file, the API key included. The features it does not have — variable
 * expansion, multi-line values, `export` prefixes — are features that would let a `.env` do
 * something surprising, and `.env.example` uses none of them.
 *
 * Trailing `# comment` after an unquoted value is stripped, because `.env.example` writes its
 * documentation that way.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const name = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : null;
    if (quote !== null && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out[name] = value;
  }

  return out;
}

// -----------------------------------------------------------------------------------------------
// The environment
// -----------------------------------------------------------------------------------------------

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * `RIKI_*` → a layer.
 *
 * A variable set to the empty string is treated as *unset*. That is what makes `.env.example`
 * shippable: it lists `RIKI_GSI_TOKEN=` and `RIKI_DOTA_PATH=` with no value, and a developer who
 * copies it unchanged should get the defaults rather than an empty port and an empty path.
 */
export function fromEnv(env: EnvRecord): ConfigLayer {
  const layer: ConfigLayer = {};
  for (const key of CONFIG_KEY_LIST) {
    const value = env[CONFIG_KEYS[key]];
    if (value === undefined || value.trim() === '') continue;
    layer[key] = value;
  }
  return layer;
}

// -----------------------------------------------------------------------------------------------
// CLI flags
// -----------------------------------------------------------------------------------------------

/**
 * `--gsi-port 53101`, `--gsi-port=53101`, `--unprompted`, `--no-unprompted`.
 *
 * Unrecognised arguments are ignored rather than rejected: Electron and Chromium put their own
 * switches on this argv (`--inspect`, `--enable-features=…`, the app path itself), so an unknown
 * flag is the normal case here and cannot be an error the way an unknown key in `settings.json`
 * can be.
 */
export function parseFlags(argv: readonly string[]): ConfigLayer {
  const layer: ConfigLayer = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) continue;

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);

    const negated = name.startsWith('--no-') ? `--${name.slice('--no-'.length)}` : null;
    if (negated !== null) {
      const key = keyForFlag(negated);
      if (key !== null && BOOLEAN_KEYS.includes(key)) layer[key] = false;
      continue;
    }

    const key = keyForFlag(name);
    if (key === null) continue;

    if (eq !== -1) {
      layer[key] = arg.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      layer[key] = next;
      i += 1;
    } else if (BOOLEAN_KEYS.includes(key)) {
      layer[key] = true;
    }
  }

  return layer;
}

// -----------------------------------------------------------------------------------------------
// The user config file
// -----------------------------------------------------------------------------------------------

export class UnknownSettingError extends Error {
  readonly key: string;

  constructor(key: string, known: readonly string[]) {
    super(
      `settings.json has an unknown setting "${key}". ` + `Known settings: ${known.join(', ')}.`,
    );
    this.name = 'UnknownSettingError';
    this.key = key;
  }
}

/**
 * A parsed `settings.json` → a layer, flattening its nesting into the same dotted keys.
 *
 * **An unknown key is an error, not a shrug.** A typo in a hand-edited settings file is exactly
 * the case REPO_SKELETON.md §7 is about: the setting silently has no effect, and the developer
 * discovers it ten minutes into a game. Nothing writes this file, so there is no migration to
 * weigh against saying so.
 */
export function fromSettings(raw: unknown): ConfigLayer {
  const layer: ConfigLayer = {};
  if (typeof raw !== 'object' || raw === null) return layer;

  const walk = (node: object, prefix: string): void => {
    for (const [name, value] of Object.entries<unknown>(node as Record<string, unknown>)) {
      const path = prefix === '' ? name : `${prefix}.${name}`;
      if (CONFIG_KEY_LIST.includes(path as ConfigKey)) {
        layer[path as ConfigKey] = value;
        continue;
      }
      // Only descend into a plain object: an array or a null at a non-key path is a mistake, and
      // recursing into it would report a confusing child path instead of the one that is wrong.
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        walk(value, path);
        continue;
      }
      throw new UnknownSettingError(path, CONFIG_KEY_LIST);
    }
  };

  walk(raw, '');
  return layer;
}

// -----------------------------------------------------------------------------------------------
// Merging
// -----------------------------------------------------------------------------------------------

/** Highest wins, so the caller passes them in that order: flags, environment, file. */
export function mergeLayers(...layers: readonly ConfigLayer[]): ConfigLayer {
  const merged: ConfigLayer = {};
  for (const layer of [...layers].reverse()) {
    for (const key of CONFIG_KEY_LIST) {
      if (key in layer) merged[key] = layer[key];
    }
  }
  return merged;
}

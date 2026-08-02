/**
 * The only file in Riki that touches `process.env`, and the only place an `ApiKey` is built.
 *
 * A lint boundary (REPO_SKELETON.md §6.2) confines `process.env` to this package, and everything
 * else in this package takes an `EnvRecord` by argument — so this file is the whole of the
 * environment surface, and it is nine lines long. That is what §7.1 means by "read in exactly one
 * place", and it is what makes replacing the env-var scheme at distribution a one-file change.
 *
 * ## Why the key never becomes a layered setting
 *
 * `keys.ts` has no row for `RIKI_OPENAI_API_KEY`, so it cannot arrive from a CLI flag (visible in
 * the machine's process list) or from `settings.json` (a file that is neither gitignored nor
 * redacted). It is read here, from the environment, and handed to the `ApiKey` constructor in the
 * same expression it was read in — ADR-0022 is explicit that wrapping a value that was already
 * copied into a variable and logged on the way is closing the door afterwards.
 */

import { ApiKey } from '@riki/realtime';

import type { EnvRecord } from './sources.js';

export const API_KEY_VAR = 'RIKI_OPENAI_API_KEY';

/**
 * `process.env`, as a plain record.
 *
 * The one call. Everything downstream is a pure function of what this returns, which is why the
 * layering, the coercions and the key's own conditional-required rule are all Tier 1 tests.
 */
export function readProcessEnv(): EnvRecord {
  return process.env;
}

/**
 * Present but malformed.
 *
 * Deliberately not a prefix check: `sk-`, `sk-proj-` and whatever comes next are OpenAI's to
 * change, and a validator that rejects a working key is worse than one that accepts a broken one.
 * What it does catch is the three ways a key actually arrives wrong — pasted with the surrounding
 * quotes, wrapped across a line, or left as a placeholder — all of which show up as whitespace in
 * the middle or as something far too short.
 */
function malformed(value: string): string | null {
  if (/^["']|["']$/.test(value)) return 'it is wrapped in quotes — the value needs none';
  if (/\s/.test(value)) return 'it contains whitespace — check for a line break or a stray space';
  if (value.length < 20) return 'it is too short to be an OpenAI key';
  return null;
}

/**
 * The key, or null.
 *
 * Null is a supported mode and not a failure: absent, the app boots with voice disabled and says
 * so (ADR-0006), which is the mode fixtures, tests and CI all run in. Blank counts as absent
 * because `.env.example` ships the variable with no value.
 *
 * @throws Error naming the variable, and never carrying the value.
 */
export function readApiKey(env: EnvRecord): ApiKey | null {
  const raw = env[API_KEY_VAR];
  if (raw === undefined || raw.trim() === '') return null;

  const reason = malformed(raw.trim());
  if (reason !== null) {
    // The message must never carry the value: this string reaches a log, and a broken key is
    // still a key. `raw` is not interpolated anywhere in this file.
    throw new Error(
      `${API_KEY_VAR} is set but ${reason}. Leave it blank to run with voice disabled. ` +
        'See REPO_SKELETON.md §7.1.',
    );
  }

  return new ApiKey(raw.trim());
}

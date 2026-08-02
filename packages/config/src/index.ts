/**
 * @riki/config
 *
 * Resolves configuration once at startup and hands it out by injection thereafter.
 *
 * This is the only module in the repo permitted to read `process.env` — a lint rule enforces it
 * (§6.2). That is what keeps `RIKI_OPENAI_API_KEY` (§7.1) traceable to one auditable file, and what
 * makes replacing the env-var scheme at distribution time a one-file change.
 *
 * ⚠ **The narrow slice, not the package.** REPO_SKELETON.md §7 specifies layered resolution — CLI
 * flags → environment → user config file → committed defaults — validated with zod and failing at
 * startup with the offending key named. **None of that is here yet.** What is here is the
 * environment layer, and only the settings that could not be obtained any other way:
 *
 * | Setting | Why it could not wait |
 * |---|---|
 * | `RIKI_OPENAI_API_KEY` | The LLM coach cannot authenticate without it, and the lint rule confining `process.env` to this package exists precisely so the key has one auditable home |
 * | `RIKI_COACH_MODEL` | It configures the thing that needs the key |
 *
 * **There is deliberately no `RIKI_COACH`.** Which coach runs is a *product* choice a player makes,
 * so it is the tray's Coach row and `settings.json` — never an environment variable. An earlier
 * draft resolved the mode here and it was removed: a variable left in a shell profile silently
 * undoing the choice the player made in the menu is precisely the confusion the UI control exists
 * to prevent, and two writers for one setting is a reconciliation nobody can see. `RIKI_COACH_MODEL`
 * survives because a model **id** is not a mode — it configures the LLM coach, it does not select it,
 * the same way `RIKI_REALTIME_MODEL` configures the voice session.
 *
 * Everything else in `.env.example` is still unread, and `apps/desktop/src/main/shell/config.ts` is
 * still the stand-in that says so. This exists because the alternative was reading the environment
 * somewhere it is banned, or shipping a coach that can never run — and both are worse than a
 * package that is honestly a third finished.
 *
 * **When the rest of §7 lands, this file grows; it does not move.** The shape a caller should keep
 * is the one below: resolve once at startup, hand the result out by injection, and never export the
 * raw environment.
 *
 * See REPO_SKELETON.md §7.1, ADR-0006 (why an environment variable at all), ADR-0022 (why the key
 * is a class rather than a string).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiKey } from '@riki/realtime';

export { ApiKey };

/**
 * Which coach runs.
 *
 * Owned by the tray's Coach row and persisted to `settings.json`. This package names the type
 * because the type is config vocabulary; it does **not** resolve the value, because no environment
 * variable selects a coach (see the header).
 */
export type CoachMode = 'static' | 'llm';

export interface CoachSettings {
  /**
   * Blank in the environment means "the package default"; this carries `null` for that.
   *
   * The model id only. There is no `mode` here on purpose — this interface is what the *environment*
   * layer knows about the coach, and the environment does not get a say in which one runs.
   */
  readonly model: string | null;
}

export interface ResolvedConfig {
  /**
   * `null` when the variable is absent or blank, which is a **supported mode** rather than an error
   * (§7.1): the app boots with voice and the LLM coach disabled and says so. Present but malformed
   * fails at the point of use naming the variable — `ApiKey`'s constructor does that.
   */
  readonly openAiKey: ApiKey | null;
  readonly coach: CoachSettings;
}

/**
 * A `.env` parser, and deliberately not `dotenv`.
 *
 * Twenty lines against a dependency in the one package whose whole job is to be auditable. It does
 * the subset `.env.example` uses — `KEY=value`, `#` comments, optional surrounding quotes — and it
 * does **not** do interpolation, multi-line values or `export` prefixes. If a developer's `.env`
 * needs one of those, that is the moment to take the dependency, not before.
 */
export function parseDotEnv(text: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    // Everything after the first `=`, minus a trailing ` # comment`. `.env.example` documents every
    // variable with one, so a parser that kept it would hand the SDK a key with prose after it.
    let value = line.slice(eq + 1).trim();
    const comment = value.search(/\s#/);
    if (comment >= 0) value = value.slice(0, comment).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** A missing or unreadable `.env` is *no variables*, never a throw: the file is optional. */
function readDotEnv(dir: string): Readonly<Record<string, string>> {
  try {
    return parseDotEnv(readFileSync(join(dir, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

export interface ResolveConfigOptions {
  /**
   * Where to look for `.env`. The repository root in a dev run.
   *
   * Injected rather than derived from `process.cwd()` so this function is testable, and so a
   * packaged build can say it has no `.env` at all by passing `null`.
   */
  readonly dotEnvDir?: string | null;
  /** Test seam. Defaults to the real environment; a test passes its own map instead. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The one impure function in the package, and the one place `process.env` is read in the repo.
 *
 * Precedence is environment over `.env`, which is §7's ordering with the two layers that exist: a
 * variable exported in the shell beats the file, so `RIKI_COACH_MODEL=… pnpm dev` works without
 * editing anything.
 *
 * **The key goes from the environment into the constructor in one expression** (ADR-0022's last
 * consequence). There is no intermediate `const key = env.RIKI_OPENAI_API_KEY` for a later edit to
 * log, and no path out of this function that carries the raw string.
 */
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const dir = options.dotEnvDir;
  const file = dir === null || dir === undefined ? {} : readDotEnv(dir);
  const env = options.env ?? process.env;
  const read = (name: string): string | undefined => env[name] ?? file[name];

  const rawModel = read('RIKI_COACH_MODEL')?.trim();
  const rawKey = read('RIKI_OPENAI_API_KEY')?.trim();

  return {
    openAiKey: rawKey === undefined || rawKey === '' ? null : new ApiKey(rawKey),
    coach: {
      model: rawModel === undefined || rawModel === '' ? null : rawModel,
    },
  };
}

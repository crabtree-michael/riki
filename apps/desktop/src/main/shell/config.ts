/**
 * The shell's configuration, which is `@riki/config`'s.
 *
 * This file used to be a stand-in with its own defaults, because REPO_SKELETON.md §10 step 3 had
 * not landed and the shell needed a port and a token before it could bind a socket. Step 3 has
 * landed, so what is left is the projection its header promised: a type alias and one adapter for
 * tests. Nothing here declares a default, and nothing here reads the environment — the lint rule
 * confining `process.env` to `packages/config` (§6.2) is what keeps `RIKI_OPENAI_API_KEY`
 * traceable to one auditable file, and the shell now gets the key by injection like everything
 * else.
 *
 * `RikiConfig` rather than a narrower projection: every field on it is a setting the composition
 * root wires somewhere, and a second type listing a subset would be one more thing to update when
 * a setting is added.
 *
 * **One credential.** `openai.apiKey` is it, and the Realtime session (ADR-0006) is now the only
 * thing that takes one. Two fields for one key would be two places to forget to redact, and
 * `ApiKey` exists precisely because that kind of forgetting is the realistic failure.
 *
 * ## ⚠ Three settings this shell no longer reads
 *
 * `coach.mode`, `coach.model` and `privacy.unprompted` are all still resolved by `@riki/config` and
 * all three now reach **nothing**: ADR-0042 deleted both coaches and the unprompted speech path.
 * `privacy.unprompted` is the one that matters, because it is a row in REPO_SKELETON.md §7.2's
 * defaults-off table and `.env.example` still documents `RIKI_UNPROMPTED` — a privacy toggle that
 * does nothing is worse than an absent one.
 *
 * They are left in place deliberately rather than removed here: `packages/config` is T10's to own
 * in the conversational migration, and two agents editing one schema is exactly what the ownership
 * map exists to prevent. **T10 removes all three**, along with their `.env.example` rows and the
 * `RIKI_UNPROMPTED` entry in `test/repo-hygiene.test.ts`.
 */

import { resolveConfig } from '@riki/config';
import type { ApiKey, CoachMode, ConfigLayer, RikiConfig } from '@riki/config';

export type { RikiConfig, CoachMode };
export type ShellConfig = RikiConfig;

export { DEFAULTS, voiceEnabled } from '@riki/config';

export interface ResolveShellConfigInput {
  readonly dataDir: string;
  /** Generated per install and persisted by `bootstrap.ts`; this file does no I/O. */
  readonly gsiToken: string;
  /**
   * Merged layers, if any. In production `loadConfig` builds this from flags, the environment and
   * `settings.json`; a test passes the two or three keys it cares about and gets the defaults for
   * everything else.
   */
  readonly layer?: ConfigLayer;
  /**
   * Absent means no key: voice disabled (ADR-0006) *and* the LLM coach unbuildable (ADR-0031).
   * One credential, one field — and it is the mode every test runs in.
   */
  readonly apiKey?: ApiKey | null;
}

/**
 * A `ShellConfig` from an explicit layer — the seam a test drives.
 *
 * Production goes through `@riki/config`'s `loadConfig`, which does the I/O and then calls the
 * same `resolveConfig` this does. Both paths therefore share one set of defaults and one
 * validator, which is the property the old stand-in could not have.
 *
 * @throws ConfigError naming every offending key.
 */
export function resolveShellConfig(input: ResolveShellConfigInput): ShellConfig {
  return resolveConfig({
    layer: input.layer ?? {},
    dataDir: input.dataDir,
    gsiToken: input.gsiToken,
    apiKey: input.apiKey ?? null,
  });
}

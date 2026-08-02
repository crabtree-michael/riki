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
 */

import { resolveConfig } from '@riki/config';
import type { ConfigLayer, RikiConfig } from '@riki/config';
import type { ApiKey } from '@riki/realtime';

export type { RikiConfig };
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
  /** Absent means voice is disabled, which is the mode every test runs in (ADR-0006). */
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

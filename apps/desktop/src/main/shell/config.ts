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
 * ## Three things that changed shape when the stand-in went
 *
 * **`coach.apiKey` is gone as a separate field.** There is one credential — `openai.apiKey` — and
 * both the LLM coach (ADR-0031) and the Realtime session (ADR-0006) take it from there. Two fields
 * for one key is two places to forget to redact, and `ApiKey` exists precisely because that kind of
 * forgetting is the realistic failure. `shell/index.ts` reads it for the driver exactly as before.
 *
 * **`unprompted` is now `privacy.unprompted`, and it defaults off.** REPO_SKELETON.md §7.2 rule 2
 * requires it; the stand-in had it on, which disagreed with the document and with `.env.example`.
 *
 * **`coach.mode` still has exactly one source and it is still not the environment.** That rule moved
 * into `packages/config`'s `keys.ts`, where the row's environment variable is `null` — which also
 * removes the CLI flag, because a flag is the same hazard at a different volume. A `RIKI_COACH` in a
 * shell profile silently undoing the tray's Coach row on every restart is what both halves prevent.
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

/**
 * ⚠ **A stand-in for `@riki/config`, and it must not outlive it.**
 *
 * REPO_SKELETON.md §10 step 3 — `packages/config`, layered resolution, and the API key — has not
 * landed: that package still exports `{}`. The shell needs a port number and a token before it can
 * bind a socket, so this is the smallest thing that lets step 6 be built and tested, and it is
 * deliberately missing the two features that make `@riki/config` worth having:
 *
 * - **No `process.env`.** A lint rule confines `process.env` to `packages/config` (§6.2), and that
 *   rule is exactly right — it is what keeps `RIKI_OPENAI_API_KEY` traceable to one auditable
 *   file. So none of `.env.example`'s variables are readable from here, `RIKI_OPENAI_API_KEY`
 *   included, and this type has no field for a key. That is the single largest reason the voice
 *   path is not wired in this step; see `silent-session.ts`.
 * - **No layering and no validation.** Defaults, plus whatever the caller passes. `@riki/config`
 *   owns CLI flags → environment → user file → defaults, and owns failing at startup with the
 *   offending key named.
 *
 * When step 3 lands, `ShellConfig` becomes a projection of `RikiConfig` and this file's body goes
 * away. Everything downstream already takes it by injection, so that is a one-file change — which
 * is the only reason writing a temporary one is defensible at all.
 */

import { DEFAULT_GSI_PORT } from '@riki/gsi';

export interface GsiConfig {
  readonly port: number;
  /**
   * Per-install, generated on first run and written into Dota's cfg. Not a secret to share across
   * machines, but never committed — and never logged: `packages/gsi`'s authenticator is careful
   * not to echo it and nothing here should undo that.
   */
  readonly token: string;
}

export interface VisionConfig {
  /**
   * **Off by default, and that is not a placeholder value.** `crates/riki-vision`'s `main()` is an
   * empty function: it spawns, exits immediately, and the supervisor backs off and gives up. On
   * until the sidecar does something would mean every launch spends ten restarts discovering that.
   */
  readonly enabled: boolean;
  /** Absolute path to the `riki-vision` binary. Resolved by the caller; unused while disabled. */
  readonly binaryPath: string | null;
}

export interface LogTailConfig {
  /** Dota's `console.log`. Null disables the source — the game writes it only with `-conclearlog`. */
  readonly path: string | null;
  readonly pollMs: number;
}

export interface HotkeyConfig {
  /** ui-design.md §6.3. Electron accelerator syntax. */
  readonly talk: string;
}

export interface ShellConfig {
  readonly gsi: GsiConfig;
  readonly vision: VisionConfig;
  readonly logTail: LogTailConfig;
  readonly hotkey: HotkeyConfig;
  /** Directory for durable memory (ADR-0013). `app.getPath('userData')` in production. */
  readonly dataDir: string;
  /** dota2 §6.4's off switch, persisted. `RIKI_UNPROMPTED=off` is the same setting. */
  readonly unprompted: boolean;
}

/** `.env.example`'s `RIKI_GSI_PORT`, and the port `tools/setup-gsi-cfg` will write into the cfg. */
export const DEFAULTS: Omit<ShellConfig, 'gsi' | 'dataDir'> & {
  readonly gsi: Omit<GsiConfig, 'token'>;
} = {
  gsi: { port: DEFAULT_GSI_PORT },
  vision: { enabled: false, binaryPath: null },
  logTail: { path: null, pollMs: 250 },
  hotkey: { talk: 'Control+`' },
  unprompted: true,
};

export interface ShellConfigOverrides {
  readonly gsi?: Partial<GsiConfig>;
  readonly vision?: Partial<VisionConfig>;
  readonly logTail?: Partial<LogTailConfig>;
  readonly hotkey?: Partial<HotkeyConfig>;
  readonly unprompted?: boolean;
}

export interface ResolveShellConfigInput extends ShellConfigOverrides {
  readonly dataDir: string;
  /** The per-install GSI token. The caller generates and persists it; this file does no I/O. */
  readonly gsiToken: string;
}

export function resolveShellConfig(input: ResolveShellConfigInput): ShellConfig {
  return {
    dataDir: input.dataDir,
    gsi: {
      port: input.gsi?.port ?? DEFAULTS.gsi.port,
      token: input.gsi?.token ?? input.gsiToken,
    },
    vision: {
      enabled: input.vision?.enabled ?? DEFAULTS.vision.enabled,
      binaryPath: input.vision?.binaryPath ?? DEFAULTS.vision.binaryPath,
    },
    logTail: {
      path: input.logTail?.path ?? DEFAULTS.logTail.path,
      pollMs: input.logTail?.pollMs ?? DEFAULTS.logTail.pollMs,
    },
    hotkey: { talk: input.hotkey?.talk ?? DEFAULTS.hotkey.talk },
    unprompted: input.unprompted ?? DEFAULTS.unprompted,
  };
}

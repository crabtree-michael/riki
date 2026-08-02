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

import type { ApiKey, CoachMode, CoachSettings } from '@riki/config';
import { DEFAULT_GSI_PORT } from '@riki/gsi';

export type { CoachMode };

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

/**
 * Which coach runs, and how the LLM one is configured.
 *
 * `mode` is the only setting in this file that can change while the app is up
 * (`RikiShell.setCoachMode`). Everything else here is read once at construction, and that asymmetry
 * is deliberate rather than an oversight: a port number cannot be rebound without dropping a socket,
 * whereas swapping the coach is disposing one object and building another inside a match runtime
 * that already gets rebuilt every game (ADR-0026).
 *
 * `apiKey` is the one field `ShellConfig` could not have before `packages/config` existed at all —
 * see this file's header. It is an opaque `ApiKey` (ADR-0022), so a `console.log` of the whole
 * config object renders it `[redacted]`, which is the accident this shape exists to survive.
 */
export interface CoachConfig {
  readonly mode: CoachMode;
  /** Null means `packages/coach`'s own default tier. */
  readonly model: string | null;
  /**
   * Null disables the LLM coach regardless of `mode`.
   *
   * The degradation is reported **once**, by the shell, at the point the driver would have been
   * built — not per turn. A coach that quietly does nothing because a variable is unset is the
   * failure REPO_SKELETON.md §7.1 describes as "discovering it ten minutes into a game".
   */
  readonly apiKey: ApiKey | null;
}

export interface DebugConfig {
  /**
   * The inspector window — dev-only, and **off unless asked for**.
   *
   * Not a placeholder default. With it off the shell installs no observing policy, so the extra
   * gate evaluations in `main/debug/observing-policy.ts` never run; it adds no tray row, so there
   * is no menu item that opens a window most people do not want; and it builds no hub, so no
   * rendered snapshot, brief or coach transcript is held in memory at all. Each of those is a
   * reason on its own, and the third is the one that makes the default a privacy decision rather
   * than a performance one.
   *
   * There is no settings surface yet (`src/renderer/settings/` is a skeleton), so this is turned on
   * by `{"debug": {"enabled": true}}` in `settings.json` under the app's data directory, or by
   * `RIKI_DEBUG` — see `.env.example`.
   */
  readonly enabled: boolean;
}

export interface ShellConfig {
  readonly gsi: GsiConfig;
  readonly vision: VisionConfig;
  readonly logTail: LogTailConfig;
  readonly hotkey: HotkeyConfig;
  readonly coach: CoachConfig;
  readonly debug: DebugConfig;
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
  // `static`, and it stays `static` until open questions 22 and 23 have an answer. The
  // deterministic coach is the one whose behaviour is known, tunable against a fixture corpus and
  // free; defaulting to the other one would ship an unmeasured judgement and a bill.
  coach: { mode: 'static', model: null, apiKey: null },
  debug: { enabled: false },
  unprompted: true,
};

export interface ShellConfigOverrides {
  readonly gsi?: Partial<GsiConfig>;
  readonly vision?: Partial<VisionConfig>;
  readonly logTail?: Partial<LogTailConfig>;
  readonly hotkey?: Partial<HotkeyConfig>;
  /**
   * `apiKey` is deliberately absent from the *overrides* type.
   *
   * `settings.json` is spread straight into this (`bootstrap.ts`), so a field here is a field a
   * developer could put in a JSON file on disk — which is the one place REPO_SKELETON.md §7.1 says
   * the key must never be. It arrives on `ResolveShellConfigInput` instead, from `@riki/config`,
   * where the only writer is `resolveConfig`.
   */
  readonly coach?: Partial<Omit<CoachConfig, 'apiKey'>>;
  readonly debug?: Partial<DebugConfig>;
  readonly unprompted?: boolean;
}

export interface ResolveShellConfigInput extends ShellConfigOverrides {
  readonly dataDir: string;
  /** The per-install GSI token. The caller generates and persists it; this file does no I/O. */
  readonly gsiToken: string;
  /**
   * From `@riki/config`'s `resolveConfig()`, which is the only thing in the repo that reads
   * `process.env`. Absent means no key, which means the LLM coach cannot be built.
   */
  readonly openAiKey?: ApiKey | null;
  /** `RIKI_COACH` and `RIKI_COACH_MODEL`, beneath `settings.json` in precedence. */
  readonly coachSettings?: CoachSettings;
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
    coach: {
      // **The mode has exactly one source, and it is not the environment.** `settings.json` is
      // where the tray's Coach row persists the player's choice, and there is deliberately no
      // environment layer beneath it: a `RIKI_COACH` left in a shell profile would silently undo
      // that choice on every restart, and a UI control that a stale variable can override is not a
      // control. `@riki/config` documents the same decision from the other side.
      mode: input.coach?.mode ?? DEFAULTS.coach.mode,
      // The model id *does* take the environment, beneath `settings.json`. It configures the LLM
      // coach rather than selecting it, so the argument above does not apply to it.
      model: input.coach?.model ?? input.coachSettings?.model ?? DEFAULTS.coach.model,
      apiKey: input.openAiKey ?? null,
    },
    debug: { enabled: input.debug?.enabled ?? DEFAULTS.debug.enabled },
    unprompted: input.unprompted ?? DEFAULTS.unprompted,
  };
}

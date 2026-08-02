/**
 * The resolved configuration, as one value.
 *
 * Everything downstream takes this — or a projection of it — by injection. Nothing outside this
 * package reads `process.env`, and a lint boundary enforces that (REPO_SKELETON.md §6.2), which is
 * what keeps `RIKI_OPENAI_API_KEY` traceable to one auditable file and makes replacing the env-var
 * scheme at distribution a one-file change (ADR-0006).
 *
 * The shape mirrors `.env.example` section by section, deliberately: a developer who reads that
 * file and then reads this one should not have to guess which variable becomes which field.
 */

import type { ApiKey } from '@riki/realtime';
import type { ModelId, VoiceName } from '@riki/realtime';

export type { ApiKey };

export type TransportKind = 'webrtc' | 'websocket';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface OpenAiConfig {
  /**
   * Null when `RIKI_OPENAI_API_KEY` is unset or blank. That is a supported mode, not a failure:
   * the app boots with voice disabled and says so (ADR-0006), and it is the mode fixtures, tests
   * and CI all run in. Present-but-malformed is a different thing and fails at startup.
   *
   * An `ApiKey` rather than a `string` so it cannot reach a log by accident — ADR-0022.
   */
  readonly apiKey: ApiKey | null;
}

export interface RealtimeConfig {
  readonly model: ModelId;
  readonly voice: VoiceName;
  readonly transport: TransportKind;
  /** The soft ceiling the cost meter warns at. `packages/realtime`'s `DEFAULT_BUDGET_USD`. */
  readonly budgetUsd: number;
}

export interface AudioConfig {
  /** Null is the system default, which is what a fresh install uses. */
  readonly inputDeviceId: string | null;
  /** Pure added latency against a ~1–1.5 s turnaround; allowed to be zero (voice-input §3.3). */
  readonly preRollMs: number;
}

export interface GsiConfig {
  readonly port: number;
  /**
   * Per-install, generated on first run and written into Dota's cfg. Not a secret to share across
   * machines, but never committed — and never logged.
   */
  readonly token: string;
}

export interface VisionConfig {
  readonly enabled: boolean;
  /** Absolute path to the `riki-vision` binary. Null while no platform backend can capture. */
  readonly binaryPath: string | null;
  /** `RIKI_FAKE_VISION=1` — the fixture-driven sidecar rather than the Rust process. */
  readonly fake: boolean;
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
 * The four settings REPO_SKELETON.md §7.2 requires to default off, in one place so a test can
 * assert them together. A privacy default that is only written down is one that will drift.
 */
export interface PrivacyConfig {
  /** ui-design §9.3. Off. */
  readonly captions: boolean;
  /** dota2 §6.4's "only when I ask". Off. */
  readonly unprompted: boolean;
  /** No chat egress. Off, and there is no code path that reads it as true yet. */
  readonly chatEgress: boolean;
  /** Debug frame capture. Off. */
  readonly debugFrames: boolean;
}

/**
 * Which coach runs — the deterministic one or the model-driven one (ADR-0031).
 *
 * Owned by the tray's Coach row and persisted to `settings.json`, and **deliberately not settable
 * from the environment**: a `RIKI_COACH` left in a shell profile would silently undo the choice the
 * player made in the menu on every restart, and a UI control a stale variable can override is not a
 * control. `keys.ts` gives this row a `null` environment variable for exactly that reason, which is
 * what makes the rule structural rather than remembered.
 */
export type CoachMode = 'static' | 'llm';

export interface CoachConfig {
  readonly mode: CoachMode;
  /**
   * Null means `packages/coach`'s own default tier.
   *
   * The model id *does* take the environment (`RIKI_COACH_MODEL`), beneath `settings.json`. It
   * configures the LLM coach rather than selecting it, so the argument above does not apply — the
   * same way `RIKI_REALTIME_MODEL` configures the voice session without deciding whether there is
   * one.
   */
  readonly model: string | null;
}

/** What the *environment* knows about the coach. No `mode`, by the rule above. */
export interface CoachSettings {
  readonly model: string | null;
}

export interface DebugConfig {
  /**
   * The inspector window — dev-only, and **off unless asked for** (ADR-0032).
   *
   * Not a placeholder default. With it off the shell installs no observing policy, adds no tray row
   * and builds no hub — so no rendered snapshot, brief or coach transcript is held in memory at
   * all. The third of those makes the default a privacy decision rather than a performance one,
   * which is why it sits under `privacy`'s rule of being asserted by a test.
   */
  readonly enabled: boolean;
}

export interface RikiConfig {
  readonly openai: OpenAiConfig;
  readonly realtime: RealtimeConfig;
  readonly audio: AudioConfig;
  readonly gsi: GsiConfig;
  /** Auto-detected by the caller; `RIKI_DOTA_PATH` overrides for non-standard Steam installs. */
  readonly dotaPath: string | null;
  readonly vision: VisionConfig;
  readonly logTail: LogTailConfig;
  readonly hotkey: HotkeyConfig;
  readonly coach: CoachConfig;
  readonly debug: DebugConfig;
  readonly privacy: PrivacyConfig;
  readonly logLevel: LogLevel;
  /** Directory for durable memory and settings. `app.getPath('userData')` in production. */
  readonly dataDir: string;
  /** `fixtures/gsi/*.jsonl` to drive a dev session in place of the live listener. */
  readonly replayFixture: string | null;
}

/**
 * Whether a live Realtime session can be opened at all.
 *
 * A function rather than a field because the answer is *derived* — one absent credential — and a
 * stored boolean is a second thing that can disagree with the key.
 */
export function voiceEnabled(config: RikiConfig): boolean {
  return config.openai.apiKey !== null;
}

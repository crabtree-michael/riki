/**
 * The one table that ties a config field to the name a developer types.
 *
 * Every settable field appears here exactly once, keyed by its dotted path in `RikiConfig`. Three
 * things read this table and they must not drift apart: the environment reader, the CLI flag
 * parser, and the error message that names the offending key when validation fails. Making them
 * three views of one table is what makes "fails at startup naming the offending key" mechanical
 * rather than something each rule has to remember.
 *
 * A flag name is the dotted path with dots turned into dashes: `realtime.model` is
 * `--realtime-model`. Nothing chooses flag names by hand, so nothing can choose one that does not
 * correspond to a field.
 *
 * ## `RIKI_OPENAI_API_KEY` is deliberately absent
 *
 * The key is not a layered setting. It is read from the environment and nowhere else, and it goes
 * from `process.env` into the `ApiKey` constructor in one expression (ADR-0022). A CLI flag would
 * put a live key in the machine's process list; the user config file would put one in a file that
 * is neither gitignored nor redacted. Both are reachable the moment the key is a row in this
 * table, so it is not one — see `env.ts`.
 */

/** Dotted path in `RikiConfig` → the environment variable that sets it. */
export const CONFIG_KEYS = {
  'realtime.model': 'RIKI_REALTIME_MODEL',
  'realtime.voice': 'RIKI_REALTIME_VOICE',
  'realtime.transport': 'RIKI_REALTIME_TRANSPORT',
  'realtime.budgetUsd': 'RIKI_REALTIME_BUDGET_USD',
  'audio.inputDeviceId': 'RIKI_AUDIO_INPUT_DEVICE',
  'audio.preRollMs': 'RIKI_AUDIO_PRE_ROLL_MS',
  'gsi.port': 'RIKI_GSI_PORT',
  'gsi.token': 'RIKI_GSI_TOKEN',
  dotaPath: 'RIKI_DOTA_PATH',
  'vision.enabled': 'RIKI_VISION',
  'vision.binaryPath': 'RIKI_VISION_BINARY',
  'vision.fake': 'RIKI_FAKE_VISION',
  'logTail.path': 'RIKI_LOG_TAIL_PATH',
  'logTail.pollMs': 'RIKI_LOG_TAIL_POLL_MS',
  'hotkey.talk': 'RIKI_HOTKEY_TALK',
  'privacy.captions': 'RIKI_CAPTIONS',
  'privacy.unprompted': 'RIKI_UNPROMPTED',
  'privacy.chatEgress': 'RIKI_CHAT_EGRESS',
  'privacy.debugFrames': 'RIKI_DEBUG_FRAMES',
  logLevel: 'RIKI_LOG_LEVEL',
  replayFixture: 'RIKI_REPLAY_FIXTURE',
} as const;

export type ConfigKey = keyof typeof CONFIG_KEYS;

export const CONFIG_KEY_LIST = Object.keys(CONFIG_KEYS) as readonly ConfigKey[];

/** The fields a bare `--flag` / `--no-flag` may set. Everything else needs a value. */
export const BOOLEAN_KEYS: readonly ConfigKey[] = [
  'vision.enabled',
  'vision.fake',
  'privacy.captions',
  'privacy.unprompted',
  'privacy.chatEgress',
  'privacy.debugFrames',
];

/** `realtime.model` → `--realtime-model`. Mechanical, so a flag cannot name a missing field. */
export function flagNameFor(key: ConfigKey): string {
  return `--${key.replace(/\./g, '-')}`;
}

const BY_FLAG = new Map<string, ConfigKey>(
  CONFIG_KEY_LIST.map((key) => [flagNameFor(key), key] as const),
);

export function keyForFlag(flag: string): ConfigKey | null {
  return BY_FLAG.get(flag) ?? null;
}

/**
 * How to name this field to a human: the environment variable, with the dotted path after it.
 *
 * Both halves are load-bearing. A developer who set `RIKI_GSI_PORT=abc` needs to see that string;
 * one who put `"gsi": { "port": "abc" }` in `settings.json` needs the path.
 */
export function describeKey(key: string): string {
  const env = (CONFIG_KEYS as Readonly<Record<string, string>>)[key];
  return env === undefined ? key : `${env} (${key})`;
}

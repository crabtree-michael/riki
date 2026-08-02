/**
 * The three things the shell needs that only a real machine can answer: where its data lives,
 * what its GSI token is, and where its files are.
 *
 * Separated from `index.ts` so that file stays what its header promises — lifecycle and nothing
 * else — and separated from `shell/config.ts` because that file does no I/O and this one is
 * entirely I/O.
 *
 * ⚠ Every function here moves into `packages/config` when REPO_SKELETON.md §10 step 3 lands. It is
 * that package's job: layered resolution, validation, and the environment. This does the subset
 * the shell cannot start without, and it does it **without reading `process.env`** — the lint rule
 * that reserves that for `packages/config` is what keeps `RIKI_OPENAI_API_KEY` traceable to one
 * auditable file, and working around it here to save a step would be the exact failure it exists
 * to prevent.
 *
 * The consequence is worth stating plainly: **none of `.env.example` is honoured yet.** A
 * developer who sets `RIKI_GSI_PORT` will find it ignored. The settings that exist live in
 * `settings.json` under the app's data directory instead, which is the "user config file" layer
 * `packages/config` will keep.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShellConfigOverrides } from './shell/config.js';

export const SETTINGS_FILE = 'settings.json';
export const GSI_TOKEN_FILE = 'gsi-token';

/** 32 bytes of base64url. Long enough that guessing it is not the attack (`packages/gsi`'s §4.1). */
const TOKEN_BYTES = 32;

/**
 * The per-install GSI token, generated once and reused.
 *
 * It has to be stable across launches because it is written into Dota's
 * `gamestate_integration_riki.cfg`, and a token that changed every start would mean every POST
 * after the first launch was refused with a 403 that looks exactly like a misconfigured cfg.
 *
 * Not a secret to share across machines, but not committed and not logged either: `packages/gsi`'s
 * authenticator is careful never to echo it, and it would be a shame to undo that here.
 */
export function loadOrCreateGsiToken(dataDir: string): string {
  const path = join(dataDir, GSI_TOKEN_FILE);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing !== '') return existing;
  } catch {
    // Missing or unreadable. Either way the answer is a new token.
  }
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  mkdirSync(dataDir, { recursive: true });
  // Owner-only: it is a shared secret with the game client and nothing else on the machine needs
  // it. `mode` is advisory on Windows and honoured on macOS, the primary target.
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

/**
 * `settings.json`, if there is one. Total: a missing or corrupt file is *no overrides*.
 *
 * Deliberately not validated beyond its shape. `@riki/config` owns "fail at startup with the
 * offending key named", and a half-validation here would be a second, weaker set of rules to
 * reconcile with that one later.
 */
export function loadSettings(dataDir: string): ShellConfigOverrides {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dataDir, SETTINGS_FILE), 'utf8'));
  } catch {
    return {};
  }
  return typeof raw === 'object' && raw !== null ? raw : {};
}

/**
 * Persist a change the player made in the UI. Read-modify-write, and **total**.
 *
 * This is what makes the tray's Coach row a *setting* rather than a gesture: without it the toggle
 * is runtime-only and every restart silently reverts to the committed default, which is the failure
 * mode of a preference that looks like it stuck. `shell/config.ts` names `settings.json` as the one
 * source of the coach mode precisely because this writes it.
 *
 * A failed write is swallowed on purpose. The alternative is an exception on the path a tray click
 * runs on, and losing a preference is a far smaller harm than taking the app down for it — the mode
 * is already applied in memory by the time this is called, so the click still did what it looked
 * like it did.
 */
export function saveSettings(dataDir: string, patch: Readonly<Record<string, unknown>>): void {
  try {
    const current = loadSettings(dataDir) as Record<string, unknown>;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, SETTINGS_FILE),
      `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // See above: a preference that failed to persist is not worth a crash.
  }
}

export interface ShellPaths {
  readonly preload: string;
  readonly overlayEntry: string;
  readonly trayIcons: string;
}

/**
 * Where the compiled preload, the overlay document and the tray glyphs are, relative to this
 * module.
 *
 * `tsc --build` mirrors `src/` into `dist/`, so everything is under `dist/`, including the
 * renderer's `index.html` — `tsc` copies no assets, so `scripts/copy-renderer-assets.mjs` puts it
 * there, and `pnpm dev` runs that before launching. Loading the document from `src/` instead
 * would half-work in the worst way: `index.html` loads `./index.js` and `./overlay.css` relative
 * to itself, so the stylesheet would resolve and the script would not.
 *
 * `appRoot` is `app.getAppPath()`, which is `apps/desktop` in a dev run and the asar root in a
 * packaged one. There is no packaging step yet — `pnpm build` is still `not-scaffolded.mjs`.
 */
export function resolvePaths(appRoot: string): ShellPaths {
  return {
    preload: join(appRoot, 'dist', 'preload', 'index.js'),
    overlayEntry: join(appRoot, 'dist', 'renderer', 'overlay', 'index.html'),
    trayIcons: join(appRoot, 'resources', 'tray'),
  };
}

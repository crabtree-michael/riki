/**
 * The two things the shell needs that only a real machine can answer: what its GSI token is, and
 * where its files are.
 *
 * Separated from `index.ts` so that file stays what its header promises — lifecycle and nothing
 * else — and separated from `shell/config.ts` because that file does no I/O and this one is
 * entirely I/O.
 *
 * **Configuration is no longer here.** `@riki/config` owns the layering, the validation and the
 * environment, so `.env`, `settings.json`, `RIKI_*` and the CLI flags are all honoured now — the
 * stand-in this file used to hold honoured none of them. What is left is the one input
 * `packages/config` deliberately does not produce: the per-install GSI token, which is generated
 * and persisted rather than configured.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GSI_TOKEN_FILE = 'gsi-token';
export const INSTALL_ID_FILE = 'install-id';

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
 * The `OpenAI-Safety-Identifier` sent when minting a client secret (ADR-0015).
 *
 * A hash of a random per-install value, and *not* of anything the player is: realtime research §6
 * says a client-supplied identifier is worthless for abuse attribution anyway, and dota2 §7
 * requires the Steam ID be hashed before any egress — so the cheapest correct thing is to send
 * something that was never derived from an identity at all. Stable across launches so a single
 * install looks like one client rather than one per session.
 */
export function loadOrCreateInstallId(dataDir: string): string {
  const path = join(dataDir, INSTALL_ID_FILE);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing !== '') return existing;
  } catch {
    // Missing or unreadable. Either way the answer is a new one.
  }
  const id = createHash('sha256').update(randomBytes(32)).digest('hex').slice(0, 32);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, id, { mode: 0o600 });
  return id;
}

export interface ShellPaths {
  readonly preload: string;
  readonly overlayEntry: string;
  readonly trayIcons: string;
  /** The voice window's preload and document (ADR-0010, ADR-0034). */
  readonly voicePreload: string;
  readonly voiceEntry: string;
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
    // `.cjs`, not `.js`. Electron loads a preload as CommonJS and this package is
    // `"type": "module"`, so the ESM `tsc` emits fails with "Cannot use import statement outside a
    // module" — reported to the *renderer's* console, which nothing reads, while main carries on.
    // `scripts/bundle.mjs` emits the CommonJS half. See ADR-0034.
    preload: join(appRoot, 'dist', 'preload', 'index.cjs'),
    overlayEntry: join(appRoot, 'dist', 'renderer', 'overlay', 'index.html'),
    trayIcons: join(appRoot, 'resources', 'tray'),
    // Its own preload, so the voice window sees only the surface it needs and the overlay cannot
    // open a session. The document loads `bundle.js`, not `index.js` — the voice renderer imports
    // workspace packages and a browser cannot resolve a bare specifier (ADR-0034).
    voicePreload: join(appRoot, 'dist', 'preload', 'voice.cjs'),
    voiceEntry: join(appRoot, 'dist', 'renderer', 'voice', 'index.html'),
  };
}

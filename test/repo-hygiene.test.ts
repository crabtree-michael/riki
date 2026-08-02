import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { API_KEY_VAR, CONFIG_KEYS } from '@riki/config';

import { resolvePaths } from '../apps/desktop/src/main/bootstrap.js';

/**
 * Repo-level guards. These are the tests REPO_SKELETON.md §5.4 asks for that need no product
 * code, so they can exist from the skeleton onward.
 *
 * The rest of §5.4's table lands with the packages it guards.
 */

const gitCheckIgnore = (path: string): boolean => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('secrets', () => {
  // The whole alpha/beta API-key scheme (§7.1) rests on this one line. gitleaks is the
  // backstop; the .gitignore entry is the actual protection.
  it('ignores .env', () => {
    expect(gitCheckIgnore('.env')).toBe(true);
  });

  it('ignores .env variants such as .env.local', () => {
    expect(gitCheckIgnore('.env.local')).toBe(true);
  });

  it('does not ignore .env.example, which is committed', () => {
    expect(gitCheckIgnore('.env.example')).toBe(false);
  });

  it('has no filled-in key in .env.example', () => {
    const example = readFileSync('.env.example', 'utf8');
    expect(example).toMatch(/^RIKI_OPENAI_API_KEY=\s*(#.*)?$/m);
    expect(example).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
  });
});

describe('.env.example', () => {
  const example = readFileSync('.env.example', 'utf8');
  const value = (key: string): string =>
    (new RegExp(`^${key}=([^#\\n]*)`, 'm').exec(example)?.[1] ?? '').trim();

  // §7.2 rule 2: privacy-relevant defaults are off, and the defaults are asserted by a test
  // rather than only written down.
  it.each([
    ['RIKI_CAPTIONS', 'off'],
    ['RIKI_UNPROMPTED', 'off'],
    // The inspector holds rendered snapshots, briefs and coach transcripts in memory while it is
    // on. That makes its default a privacy decision as much as a performance one, which puts it in
    // this table rather than only in a header (docs/design/debug-inspector.md §6).
    ['RIKI_DEBUG', 'off'],
  ])('defaults %s to %s', (key, expected) => {
    expect(value(key)).toBe(expected);
  });

  it('documents every variable packages/config actually reads', () => {
    // Derived from `CONFIG_KEYS` rather than from a hand-kept list, which is the whole point:
    // adding a setting without documenting it now fails here by name, and a list somebody has to
    // remember to extend is a list that goes stale on the first setting nobody thought about.
    // `API_KEY_VAR` is separate because the key is deliberately not a row in that table — a flag
    // would put it in the process list and `settings.json` is neither gitignored nor redacted.
    // `null` is a field the environment may not set at all (`coach.mode` — ADR-0031), so it has
    // nothing to document.
    const named: string[] = Object.values(CONFIG_KEYS).filter((name) => name !== null);
    for (const key of [API_KEY_VAR, ...named]) {
      expect(example, `${key} missing from .env.example`).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });
});

/**
 * The build wiring, because two of its steps fail in ways no unit test can reach.
 *
 * `pnpm dev` was `tsc --build && assets && electron .` for a whole step, and the overlay's preload
 * never loaded in any of that time: Electron loads a preload as **CommonJS**, this package is
 * `"type": "module"`, and the resulting "Cannot use import statement outside a module" is reported
 * to the *renderer's* console — which nothing reads — while main starts, binds its socket and runs
 * the entire coaching pipeline. `scripts/bundle.mjs` emits the CommonJS half, and the voice
 * renderer's ESM bundle alongside it (ADR-0034).
 *
 * These are shape assertions, not a substitute for launching the app. The thing that actually
 * catches this class of bug is Tier 5, and the Playwright harness is REPO_SKELETON.md §10 step 6's
 * outstanding item.
 */
describe('the desktop build', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };

  it('bundles before it launches', () => {
    const dev = manifest.scripts.dev ?? '';
    expect(dev).toContain('bundle');
    expect(dev.indexOf('bundle')).toBeLessThan(dev.indexOf('electron .'));
  });

  it('points every preload at `.cjs`, because Electron loads them as CommonJS', () => {
    // All three, derived rather than listed: a window added later with a preload nobody put in
    // `scripts/bundle.mjs` fails exactly the way the overlay's did, which is to say invisibly.
    const paths = resolvePaths('/app') as unknown as Readonly<Record<string, string>>;
    const preloads = Object.entries(paths).filter(([name]) => /preload/i.test(name));
    expect(preloads.length).toBeGreaterThanOrEqual(3);
    for (const [name, path] of preloads) {
      expect(path, `${name} must be a CommonJS bundle`).toMatch(/\.cjs$/);
    }
  });

  it('points the voice window at the bundle, not at tsc’s output', () => {
    // `index.js` would load and immediately throw `Failed to resolve module specifier
    // "@riki/audio"` — in a window that is never shown, with no DevTools open.
    const document = readFileSync(
      new URL('../apps/desktop/src/renderer/voice/index.html', import.meta.url),
      'utf8',
    );
    expect(document).toContain('./bundle.js');
    expect(document).not.toMatch(/src="\.\/index\.js"/);
  });
});

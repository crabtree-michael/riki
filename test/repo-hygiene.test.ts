import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('documents every variable packages/config is expected to read', () => {
    const required = [
      'RIKI_OPENAI_API_KEY',
      'RIKI_REALTIME_MODEL',
      'RIKI_REALTIME_VOICE',
      'RIKI_REALTIME_TRANSPORT',
      'RIKI_GSI_PORT',
      'RIKI_GSI_TOKEN',
      'RIKI_DOTA_PATH',
      'RIKI_VISION',
      'RIKI_UNPROMPTED',
      'RIKI_CAPTIONS',
      'RIKI_LOG_LEVEL',
      'RIKI_REPLAY_FIXTURE',
      'RIKI_FAKE_VISION',
      'RIKI_DEBUG',
    ];
    for (const key of required) {
      expect(example, `${key} missing from .env.example`).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });
});

import { describe, expect, it } from 'vitest';

import { API_KEY_VAR, readApiKey } from './env.js';
import { ENV_FILE, SETTINGS_FILE, findEnvFile, loadConfig } from './load.js';
import type { ConfigFileSystem } from './load.js';
import { UnknownSettingError } from './sources.js';

/**
 * A fake long enough to pass `readApiKey`'s length check and *low-entropy enough for gitleaks*.
 * The pre-commit `generic-api-key` rule is entropy-based, so a realistic-looking random string
 * here fails the gate with a leak report naming this file — which is the rule working, not a
 * false positive worth suppressing.
 */
const KEY = 'sk-test-aaaa-bbbb-cccc-dddd';

function files(map: Readonly<Record<string, string>>): ConfigFileSystem {
  return { readText: (path) => map[path] ?? null };
}

const NO_FILES = files({});

describe('the API key', () => {
  it('is absent rather than an error when unset or blank — voice off, app boots', () => {
    expect(readApiKey({})).toBeNull();
    expect(readApiKey({ [API_KEY_VAR]: '' })).toBeNull();
    expect(readApiKey({ [API_KEY_VAR]: '   ' })).toBeNull();
  });

  it('is wrapped in an ApiKey that renders as [redacted] through all three hooks (ADR-0022)', () => {
    const key = readApiKey({ [API_KEY_VAR]: KEY });
    expect(key?.reveal()).toBe(KEY);
    expect(String(key)).toBe('[redacted]');
    expect(JSON.stringify({ key })).toBe('{"key":"[redacted]"}');
    expect(
      (key as unknown as Record<symbol, () => string>)[
        Symbol.for('nodejs.util.inspect.custom')
      ]?.(),
    ).toBe('[redacted]');
  });

  it('fails loudly when present but malformed, naming the variable and never the value', () => {
    const pasted = `"${KEY}"\n`;
    let message = '';
    try {
      readApiKey({ [API_KEY_VAR]: pasted });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(API_KEY_VAR);
    expect(message).not.toContain(KEY);
  });

  it('rejects a placeholder left in .env', () => {
    expect(() => readApiKey({ [API_KEY_VAR]: 'sk-...' })).toThrow(API_KEY_VAR);
  });
});

describe('findEnvFile', () => {
  it('walks up from the working directory, because pnpm dev runs from apps/desktop', () => {
    const fs = files({ '/repo/.env': 'RIKI_LOG_LEVEL=debug' });
    expect(findEnvFile(fs, '/repo/apps/desktop')?.path).toBe(`/repo/${ENV_FILE}`);
  });

  it('finds nothing in a packaged app, which is the intended outcome', () => {
    expect(findEnvFile(NO_FILES, '/Applications/Riki.app')).toBeNull();
  });
});

describe('loadConfig', () => {
  const base = { dataDir: '/data', gsiToken: 'token', cwd: '/repo' };

  it('honours .env, which nothing did before this package existed', () => {
    const config = loadConfig({
      ...base,
      env: {},
      fs: files({ '/repo/.env': 'RIKI_GSI_PORT=54321\nRIKI_LOG_LEVEL=debug' }),
    });
    expect(config.gsi.port).toBe(54_321);
    expect(config.logLevel).toBe('debug');
  });

  it('lets the real environment beat .env, and a flag beat both', () => {
    const fs = files({
      '/repo/.env': 'RIKI_GSI_PORT=1111',
      [`/data/${SETTINGS_FILE}`]: JSON.stringify({ gsi: { port: 4444 } }),
    });

    expect(loadConfig({ ...base, fs, env: {} }).gsi.port).toBe(1111);
    expect(loadConfig({ ...base, fs, env: { RIKI_GSI_PORT: '2222' } }).gsi.port).toBe(2222);
    expect(
      loadConfig({ ...base, fs, env: { RIKI_GSI_PORT: '2222' }, argv: ['--gsi-port=3333'] }).gsi
        .port,
    ).toBe(3333);
  });

  it('puts settings.json below the environment but above the defaults', () => {
    const fs = files({ [`/data/${SETTINGS_FILE}`]: JSON.stringify({ hotkey: { talk: 'Alt+V' } }) });
    expect(loadConfig({ ...base, fs, env: {} }).hotkey.talk).toBe('Alt+V');
    expect(loadConfig({ ...base, fs, env: { RIKI_HOTKEY_TALK: 'F13' } }).hotkey.talk).toBe('F13');
  });

  it('reads the key from .env as well as from the environment', () => {
    const config = loadConfig({
      ...base,
      env: {},
      fs: files({ '/repo/.env': `${API_KEY_VAR}=${KEY}` }),
    });
    expect(config.openai.apiKey?.reveal()).toBe(KEY);
  });

  it('boots with no .env, no settings and no environment at all', () => {
    const config = loadConfig({ ...base, fs: NO_FILES, env: {} });
    expect(config.openai.apiKey).toBeNull();
    expect(config.gsi.token).toBe('token');
  });

  it('refuses a corrupt settings.json instead of silently ignoring every setting in it', () => {
    const fs = files({ [`/data/${SETTINGS_FILE}`]: '{ not json' });
    expect(() => loadConfig({ ...base, fs, env: {} })).toThrow(/not valid JSON/);
  });

  it('names a typo in settings.json', () => {
    const fs = files({ [`/data/${SETTINGS_FILE}`]: JSON.stringify({ hotkey: { tolk: 'Alt+V' } }) });
    expect(() => loadConfig({ ...base, fs, env: {} })).toThrow(UnknownSettingError);
  });
});

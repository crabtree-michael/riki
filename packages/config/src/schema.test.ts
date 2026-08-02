import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULTS, resolveConfig } from './schema.js';
import type { ConfigLayer } from './sources.js';
import { voiceEnabled } from './types.js';

const BASE = { dataDir: '/tmp/riki', gsiToken: 'a-token', apiKey: null } as const;

function resolve(layer: ConfigLayer = {}): ReturnType<typeof resolveConfig> {
  return resolveConfig({ ...BASE, layer });
}

describe('privacy defaults', () => {
  // REPO_SKELETON.md §7.2 rule 2. Asserted one at a time, deliberately: a single `toEqual` over
  // the whole object would let someone flip one to true and "fix" the test by updating the
  // expectation, which is exactly the drift this rule exists to prevent.
  it('captions are off', () => {
    expect(resolve().privacy.captions).toBe(false);
  });

  it('unprompted speech is off', () => {
    expect(resolve().privacy.unprompted).toBe(false);
  });

  it('chat egress is off', () => {
    expect(resolve().privacy.chatEgress).toBe(false);
  });

  it('debug frame capture is off', () => {
    expect(resolve().privacy.debugFrames).toBe(false);
  });

  it('and vision is off, because no platform backend can capture yet (ADR-0030)', () => {
    expect(resolve().vision.enabled).toBe(false);
  });
});

describe('resolveConfig', () => {
  it('falls back to the committed defaults when no layer has an opinion', () => {
    const config = resolve();
    expect(config.realtime.model).toBe(DEFAULTS.realtime.model);
    expect(config.gsi.port).toBe(DEFAULTS.gsi.port);
    expect(config.hotkey.talk).toBe(DEFAULTS.hotkey.talk);
    expect(config.gsi.token).toBe('a-token');
    expect(config.dataDir).toBe('/tmp/riki');
  });

  it('coerces a string from the environment and a native value from settings.json alike', () => {
    expect(resolve({ 'gsi.port': '54000' }).gsi.port).toBe(54_000);
    expect(resolve({ 'gsi.port': 54_000 }).gsi.port).toBe(54_000);
    expect(resolve({ 'privacy.captions': 'on' }).privacy.captions).toBe(true);
    expect(resolve({ 'privacy.captions': true }).privacy.captions).toBe(true);
    expect(resolve({ 'vision.fake': '1' }).vision.fake).toBe(true);
    expect(resolve({ 'vision.fake': '0' }).vision.fake).toBe(false);
  });

  it('treats a blank path as unset, so `.env.example`’s empty variables mean nothing', () => {
    expect(resolve({ dotaPath: '   ' }).dotaPath).toBeNull();
    expect(resolve({ replayFixture: '' }).replayFixture).toBeNull();
  });

  it('names the environment variable and the path when a value is wrong', () => {
    let thrown: unknown;
    try {
      resolve({ 'gsi.port': 'abc' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as ConfigError;
    expect(error.issues).toEqual([
      { key: 'gsi.port', message: expect.stringContaining('whole number') as string },
    ]);
    expect(error.message).toContain('RIKI_GSI_PORT (gsi.port)');
  });

  it('reports every bad key at once rather than one restart at a time', () => {
    let thrown: ConfigError | null = null;
    try {
      resolve({ 'gsi.port': 'abc', 'realtime.voice': 'gandalf', 'privacy.captions': 'maybe' });
    } catch (error) {
      thrown = error as ConfigError;
    }
    expect(thrown?.issues.map((issue) => issue.key).sort()).toEqual([
      'gsi.port',
      'privacy.captions',
      'realtime.voice',
    ]);
  });

  it('rejects a voice or a model the Realtime API does not have', () => {
    expect(() => resolve({ 'realtime.voice': 'gandalf' })).toThrow(/one of alloy/);
    expect(() => resolve({ 'realtime.model': 'gpt-4o' })).toThrow(/RIKI_REALTIME_MODEL/);
  });

  it('refuses an empty GSI token, because a blank one is a 403 that reads as a broken cfg', () => {
    expect(() => resolveConfig({ ...BASE, gsiToken: '', layer: {} })).toThrow(ConfigError);
  });
});

describe('voiceEnabled', () => {
  it('is false with no key, which is the mode fixtures and CI run in', () => {
    expect(voiceEnabled(resolve())).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { CONFIG_KEYS, flagNameFor } from './keys.js';
import {
  UnknownSettingError,
  fromEnv,
  fromSettings,
  mergeLayers,
  parseDotenv,
  parseFlags,
} from './sources.js';

describe('parseDotenv', () => {
  it('reads the shape .env.example is actually written in', () => {
    const parsed = parseDotenv(
      [
        '# a comment',
        '',
        'RIKI_GSI_PORT=53101',
        'RIKI_OPENAI_API_KEY=            # your own key. Required only for live voice',
        'RIKI_REALTIME_MODEL=gpt-realtime-2.1-mini   # mini by default',
        'RIKI_HOTKEY_TALK="Control+Shift+`"',
        "RIKI_DOTA_PATH='/opt/steam/dota 2'",
      ].join('\n'),
    );

    expect(parsed).toEqual({
      RIKI_GSI_PORT: '53101',
      RIKI_OPENAI_API_KEY: '',
      RIKI_REALTIME_MODEL: 'gpt-realtime-2.1-mini',
      RIKI_HOTKEY_TALK: 'Control+Shift+`',
      RIKI_DOTA_PATH: '/opt/steam/dota 2',
    });
  });

  it('keeps a `#` that is inside quotes, because a key or a password may contain one', () => {
    expect(parseDotenv('A="one#two"')).toEqual({ A: 'one#two' });
  });

  it('ignores lines that are not assignments rather than guessing at them', () => {
    expect(parseDotenv('not a line\n=novalue\n1BAD=x\nGOOD=y')).toEqual({ GOOD: 'y' });
  });
});

describe('fromEnv', () => {
  it('treats a blank variable as unset, so a copied .env.example yields the defaults', () => {
    // Every one of these ships blank in `.env.example`. If blank counted as a value, copying the
    // file unchanged would blank out the GSI token and the Dota path.
    expect(fromEnv({ RIKI_GSI_TOKEN: '', RIKI_DOTA_PATH: '   ', RIKI_GSI_PORT: '1234' })).toEqual({
      'gsi.port': '1234',
    });
  });

  it('has no row for the API key, so no layer can carry it', () => {
    expect(Object.values(CONFIG_KEYS)).not.toContain('RIKI_OPENAI_API_KEY');
    expect(fromEnv({ RIKI_OPENAI_API_KEY: 'sk-test-aaaa-bbbb-cccc-dddd' })).toEqual({});
  });
});

describe('parseFlags', () => {
  it('accepts both spellings and a bare boolean', () => {
    expect(
      parseFlags(['--gsi-port=1234', '--hotkey-talk', 'Alt+Space', '--privacy-captions']),
    ).toEqual({ 'gsi.port': '1234', 'hotkey.talk': 'Alt+Space', 'privacy.captions': true });
  });

  it('negates with --no-, but only for boolean fields', () => {
    expect(parseFlags(['--no-privacy-unprompted', '--no-gsi-port'])).toEqual({
      'privacy.unprompted': false,
    });
  });

  it('ignores the switches Electron and Chromium put on this argv', () => {
    expect(parseFlags(['--inspect=9229', '--enable-features=Foo', '/path/to/app'])).toEqual({});
  });

  it('names every flag mechanically from its field', () => {
    expect(flagNameFor('realtime.model')).toBe('--realtime-model');
  });
});

describe('fromSettings', () => {
  it('flattens the nesting into the same dotted keys the other layers use', () => {
    expect(fromSettings({ gsi: { port: 1234 }, privacy: { captions: true } })).toEqual({
      'gsi.port': 1234,
      'privacy.captions': true,
    });
  });

  it('rejects an unknown key rather than letting a typo silently do nothing', () => {
    expect(() => fromSettings({ hotkey: { tolk: 'Alt+Space' } })).toThrow(UnknownSettingError);
    expect(() => fromSettings({ hotkey: { tolk: 'Alt+Space' } })).toThrow('hotkey.tolk');
  });

  it('is empty for a missing or non-object file', () => {
    expect(fromSettings(null)).toEqual({});
    expect(fromSettings('nonsense')).toEqual({});
  });
});

describe('mergeLayers', () => {
  it('lets the earlier layer win, which is flags over environment over file', () => {
    const merged = mergeLayers(
      { 'gsi.port': 'flag' },
      { 'gsi.port': 'env', 'hotkey.talk': 'env' },
      { 'gsi.port': 'file', 'hotkey.talk': 'file', logLevel: 'file' },
    );
    expect(merged).toEqual({ 'gsi.port': 'flag', 'hotkey.talk': 'env', logLevel: 'file' });
  });

  it('distinguishes an explicit null from an absent key', () => {
    expect(mergeLayers({ dotaPath: null }, { dotaPath: '/games/dota' })).toEqual({
      dotaPath: null,
    });
  });
});

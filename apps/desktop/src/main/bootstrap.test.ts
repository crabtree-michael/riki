/**
 * `settings.json`, both directions.
 *
 * The read half has existed since step 6; the write half is new, and it is what turns the tray's
 * Coach row from a gesture into a setting. That asymmetry is worth a test on its own: the mode was
 * switchable at runtime for a while *without* anything persisting it, so every restart quietly
 * reverted to the committed default and the only symptom was a preference that did not stick.
 *
 * Everything here is real I/O into a temp directory. It is Tier 1 by REPO_SKELETON.md §5.2's rule —
 * no game, no microphone, no GPU, no window — and the filesystem is the unit under test, so faking
 * it would be faking the thing the test is about.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SETTINGS_FILE, loadOrCreateGsiToken, loadSettings, saveSettings } from './bootstrap.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'riki-bootstrap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('settings.json', () => {
  it('round-trips the coach mode, which is what makes the tray row survive a restart', () => {
    saveSettings(dir, { coach: { mode: 'llm' } });

    expect(loadSettings(dir).coach?.mode).toBe('llm');
  });

  it('merges rather than replaces, so persisting one setting does not drop the others', () => {
    saveSettings(dir, { hotkey: { talk: 'Control+Shift+R' } });
    saveSettings(dir, { coach: { mode: 'llm' } });

    const settings = loadSettings(dir);
    expect(settings.coach?.mode).toBe('llm');
    // The failure this guards is a read-modify-write that forgot the read: one tray click would
    // silently reset every other setting in the file.
    expect(settings.hotkey?.talk).toBe('Control+Shift+R');
  });

  it('reads a missing file as no overrides rather than throwing', () => {
    expect(loadSettings(dir)).toEqual({});
  });

  it('reads a corrupt file as no overrides, and can still be written over', () => {
    writeFileSync(join(dir, SETTINGS_FILE), '{ not json', 'utf8');
    expect(loadSettings(dir)).toEqual({});

    saveSettings(dir, { coach: { mode: 'llm' } });
    expect(loadSettings(dir).coach?.mode).toBe('llm');
  });

  it('swallows a write it cannot perform, because losing a preference must not take the app down', () => {
    // A path that is not a directory. The write throws inside and is caught; the caller — a tray
    // click handler — carries on, and the mode is already applied in memory by this point.
    const notADir = join(dir, 'file');
    writeFileSync(notADir, 'x', 'utf8');

    expect(() => {
      saveSettings(join(notADir, 'nested'), { coach: { mode: 'llm' } });
    }).not.toThrow();
  });

  it('writes valid JSON a human can edit', () => {
    saveSettings(dir, { coach: { mode: 'llm' } });
    const raw = readFileSync(join(dir, SETTINGS_FILE), 'utf8');

    expect(() => {
      JSON.parse(raw) as unknown;
    }).not.toThrow();
    // Indented and newline-terminated: this file is documented as the user config layer, and a
    // single-line blob is a file nobody will hand-edit.
    expect(raw).toContain('\n');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('the GSI token', () => {
  it('is stable across calls, because it is written into Dota’s cfg', () => {
    const first = loadOrCreateGsiToken(dir);
    expect(loadOrCreateGsiToken(dir)).toBe(first);
    expect(first).not.toBe('');
  });
});

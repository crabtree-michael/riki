/**
 * ADR-0020's behaviour, plus the regression for the bug that outlived the first implementation.
 *
 * These assertions are mostly about what does *not* happen. A no-op path that quietly logs, faults
 * or retries would satisfy any "it didn't duck" test while still putting an Error chip on screen
 * mid-match on the platform most users are on.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDuckingSink, createNoopDucker, DEFAULT_DUCKING, type Ducker } from './ducking.js';

/** Records what the platform was actually asked to do. */
function recordingDucker(available = true) {
  const calls: { kind: 'duck' | 'restore'; db?: number; rampMs: number }[] = [];
  const ducker: Ducker = {
    available,
    duck: (db, rampMs) => {
      calls.push({ kind: 'duck', db, rampMs });
      return Promise.resolve();
    },
    restore: (rampMs) => {
      calls.push({ kind: 'restore', rampMs });
      return Promise.resolve();
    },
  };
  return { ducker, calls };
}

describe('createNoopDucker — the default path on macOS', () => {
  it('reports itself unavailable rather than pretending', () => {
    expect(createNoopDucker().available).toBe(false);
  });

  it('accepts every call and does nothing, silently', async () => {
    // A spy is the only way to assert the *absence* of a log, which is the actual requirement.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const sink = createDuckingSink(createNoopDucker());
    await expect(sink.set(true)).resolves.toBe(false);
    await expect(sink.set(false)).resolves.toBe(false);

    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it('surfaces availability so settings can disable the control', () => {
    expect(createDuckingSink(createNoopDucker()).available).toBe(false);
  });
});

describe('where the platform can duck', () => {
  it('applies and restores with ui-design §7.2’s ramps', async () => {
    const { ducker, calls } = recordingDucker();
    const sink = createDuckingSink(ducker);

    await sink.set(true);
    await sink.set(false);

    expect(calls).toEqual([
      { kind: 'duck', db: DEFAULT_DUCKING.amountDb, rampMs: DEFAULT_DUCKING.rampInMs },
      { kind: 'restore', rampMs: DEFAULT_DUCKING.rampOutMs },
    ]);
  });

  it('is idempotent — a repeated set(true) does not re-ramp', async () => {
    const { ducker, calls } = recordingDucker();
    const sink = createDuckingSink(ducker);
    await sink.set(true);
    await sink.set(true);
    expect(calls).toHaveLength(1);
  });

  it('does nothing when the user has ducking switched off', async () => {
    const { ducker, calls } = recordingDucker();
    const sink = createDuckingSink(ducker, { ...DEFAULT_DUCKING, enabled: false });
    await expect(sink.set(true)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('restores on dispose, so a crash mid-speech cannot leave the game quiet', async () => {
    const { ducker, calls } = recordingDucker();
    const sink = createDuckingSink(ducker);
    await sink.set(true);
    await sink.dispose();
    expect(calls.at(-1)).toEqual({ kind: 'restore', rampMs: DEFAULT_DUCKING.rampOutMs });
  });
});

describe('regression: turning ducking off mid-duck', () => {
  /**
   * The bug, from the parked implementation: `setEnabled(false)` cleared the flag and then routed
   * the restore through the same method that checks the flag — which had just become false — so
   * the restore was skipped and **the game stayed attenuated for the rest of the match**, with
   * nothing in the UI to explain it and no way for the player to undo it short of restarting.
   *
   * Now unreachable on macOS (nothing ducks), but live on Linux and on any future Windows backend.
   */
  it('restores immediately rather than leaving the game quiet', async () => {
    const { ducker, calls } = recordingDucker();
    const sink = createDuckingSink(ducker);

    await sink.set(true);
    expect(calls).toHaveLength(1);

    await sink.setEnabled(false);

    expect(calls.at(-1)).toEqual({ kind: 'restore', rampMs: DEFAULT_DUCKING.rampOutMs });
    expect(sink.enabled).toBe(false);
  });

  it('does not restore when it was not ducking', async () => {
    const { ducker, calls } = recordingDucker();
    const sink = createDuckingSink(ducker);
    await sink.setEnabled(false);
    expect(calls).toEqual([]);
  });

  it('is a no-op when the setting did not change', async () => {
    const { ducker, calls } = recordingDucker();
    const sink = createDuckingSink(ducker);
    await sink.set(true);
    await sink.setEnabled(true);
    expect(calls).toHaveLength(1);
  });

  it('leaves ducking off until it is switched back on', async () => {
    const { ducker, calls } = recordingDucker();
    const sink = createDuckingSink(ducker);
    await sink.set(true);
    await sink.setEnabled(false);
    calls.length = 0;

    await expect(sink.set(true)).resolves.toBe(false);
    expect(calls).toEqual([]);

    await sink.setEnabled(true);
    await expect(sink.set(true)).resolves.toBe(true);
  });
});

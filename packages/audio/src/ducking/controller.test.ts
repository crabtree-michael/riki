/**
 * The behaviour ADR-0016 turns on: on macOS, ducking does nothing, and doing nothing is correct.
 *
 * These assertions are deliberately about what does *not* happen. A no-op path that quietly logs
 * an error, raises a fault, or retries would satisfy any "it didn't duck" test while still
 * producing an Error chip mid-match on the platform most users are on.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDuckingController,
  duckingCapability,
  DUCK_RAMP_IN_MS,
  DUCK_RAMP_OUT_MS,
} from './controller.js';
import { RecordingDuckingBackend } from '../testing/index.js';

describe('platform capability', () => {
  it('reports macOS as unavailable, with a reason fit for settings', () => {
    const capability = duckingCapability('darwin');
    expect(capability.availability).toBe('unavailable');
    expect(capability.honoursRequestedDepth).toBe(false);
    expect(capability.reason).toMatch(/no public API/i);
  });

  it('reports Windows as ducking, but not on our terms', () => {
    const capability = duckingCapability('win32');
    expect(capability.availability).toBe('system-controlled');
    // ui-design.md §7.2's −12 dB / 120 ms / 250 ms are not achievable through the comms-role
    // mechanism, so settings must not present them as if they were.
    expect(capability.honoursRequestedDepth).toBe(false);
  });

  it('reports Linux as the only platform that can honour the spec', () => {
    expect(duckingCapability('linux')).toMatchObject({
      availability: 'full',
      honoursRequestedDepth: true,
    });
  });

  it('treats an unrecognised platform as unavailable rather than assuming', () => {
    expect(duckingCapability('freebsd').availability).toBe('unavailable');
  });
});

describe('on macOS — the default path', () => {
  it('accepts duck(true) and reports that nothing was applied', () => {
    const controller = createDuckingController({ platform: 'darwin' });
    expect(controller.duck(true)).toEqual({ applied: false, availability: 'unavailable' });
  });

  it('never touches a backend, even if one is handed to it', () => {
    const backend = new RecordingDuckingBackend();
    const controller = createDuckingController({ platform: 'darwin', backend });
    controller.duck(true);
    controller.duck(false);
    expect(backend.calls).toEqual([]);
  });

  it('does not throw, and does not log', () => {
    // `no-console` is a lint error outside packages/telemetry, but a spy is the only way to
    // assert the *absence* of a log, which is the actual requirement.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = createDuckingController({ platform: 'darwin' });
    expect(() => controller.duck(true)).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });
});

describe('where ducking works', () => {
  it('applies and releases with the ramps from ui-design.md §7.2', () => {
    const backend = new RecordingDuckingBackend();
    const controller = createDuckingController({ platform: 'linux', backend });

    controller.duck(true);
    controller.duck(false);

    expect(backend.calls).toEqual([
      { kind: 'apply', rampMs: DUCK_RAMP_IN_MS },
      { kind: 'release', rampMs: DUCK_RAMP_OUT_MS },
    ]);
  });

  it('is idempotent — a repeated duck(true) does not re-ramp', () => {
    const backend = new RecordingDuckingBackend();
    const controller = createDuckingController({ platform: 'linux', backend });
    controller.duck(true);
    controller.duck(true);
    expect(backend.calls).toHaveLength(1);
  });

  it('honours the user turning ducking off, per ui-design.md §11', () => {
    const backend = new RecordingDuckingBackend();
    const controller = createDuckingController({ platform: 'linux', backend, enabled: false });
    expect(controller.duck(true).applied).toBe(false);
    expect(backend.calls).toEqual([]);
  });

  it('restores immediately when the setting is turned off mid-duck', () => {
    const backend = new RecordingDuckingBackend();
    const controller = createDuckingController({ platform: 'linux', backend });
    controller.duck(true);
    controller.setEnabled(false);
    expect(backend.calls.at(-1)).toEqual({ kind: 'release', rampMs: DUCK_RAMP_OUT_MS });
  });

  it('releases on dispose so a crash mid-speech does not leave the game quiet', () => {
    const backend = new RecordingDuckingBackend();
    const controller = createDuckingController({ platform: 'linux', backend });
    controller.duck(true);
    controller.dispose();
    expect(backend.calls.at(-1)).toEqual({ kind: 'release', rampMs: 0 });
    expect(backend.disposed).toBe(true);
  });

  it('falls back to the no-op path when no backend was supplied', () => {
    const controller = createDuckingController({ platform: 'linux' });
    expect(controller.duck(true).applied).toBe(false);
  });
});

describe('the effect is emitted unconditionally', () => {
  /**
   * overlay-architecture.md §8: the machine emits `duck` without branching on a preference or a
   * platform, and the sink honours both. This asserts the sink's half — every call is accepted
   * and answered, never rejected upward.
   */
  it('answers every call on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const controller = createDuckingController({ platform });
      expect(() => {
        controller.duck(true);
        controller.duck(false);
      }).not.toThrow();
    }
  });

  it('notifies subscribers so settings can show what actually happened', () => {
    const controller = createDuckingController({ platform: 'darwin' });
    const seen: boolean[] = [];
    controller.onChange((result) => seen.push(result.applied));
    controller.duck(true);
    expect(seen).toEqual([false]);
  });
});

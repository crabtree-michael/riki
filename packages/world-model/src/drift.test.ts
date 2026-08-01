/**
 * Tier 1. The drift monitor is the detector behind two rows of dota2 §9 — *CV confidence
 * collapse* and *resolution / HUD scale change* — so what it must get right is not the arithmetic
 * but the two ways of being wrong: calling a brief disagreement a broken calibration, and calling
 * a broken calibration healthy.
 */

import { describe, expect, it } from 'vitest';
import { createCvDriftMonitor } from './drift.js';
import { asMonoMs } from './time.js';

describe('CvDriftMonitor', () => {
  it('is ok with no samples at all, and says how many it has', () => {
    const monitor = createCvDriftMonitor();
    expect(monitor.status(asMonoMs(0))).toEqual({ agreement: 1, verdict: 'ok', samples: 0 });
  });

  it('tolerates the small disagreement of two readings taken moments apart', () => {
    // CV and GSI sample at different instants; a health bar that moved between them is not a
    // calibration failure.
    const monitor = createCvDriftMonitor();
    for (let i = 0; i < 10; i += 1) monitor.observe(1000, 1005, asMonoMs(i * 100));
    expect(monitor.status(asMonoMs(1_000)).verdict).toBe('ok');
  });

  it('does not call four disagreements a broken calibration', () => {
    const monitor = createCvDriftMonitor();
    for (let i = 0; i < 4; i += 1) monitor.observe(0, 1000, asMonoMs(i * 100));
    expect(monitor.status(asMonoMs(500)).verdict).toBe('ok');
  });

  it('reports broken once disagreement is sustained', () => {
    // This is what suppresses every CV fact and requests recalibration (§8.2).
    const monitor = createCvDriftMonitor();
    for (let i = 0; i < 20; i += 1) monitor.observe(0, 1000, asMonoMs(i * 100));

    const status = monitor.status(asMonoMs(2_000));
    expect(status.verdict).toBe('broken');
    expect(status.agreement).toBe(0);
  });

  it('reports suspect in between, so degradation has somewhere to go before gsi_only', () => {
    const monitor = createCvDriftMonitor();
    for (let i = 0; i < 20; i += 1) {
      monitor.observe(i % 5 === 0 ? 0 : 1000, 1000, asMonoMs(i * 100));
    }
    expect(monitor.status(asMonoMs(2_000)).verdict).toBe('suspect');
  });

  it('forgets samples outside the window, so a fixed calibration recovers', () => {
    const monitor = createCvDriftMonitor({ windowMs: 1_000, suspectBelow: 0.9, brokenBelow: 0.6 });
    for (let i = 0; i < 20; i += 1) monitor.observe(0, 1000, asMonoMs(i));
    expect(monitor.status(asMonoMs(100)).verdict).toBe('broken');

    for (let i = 0; i < 20; i += 1) monitor.observe(1000, 1000, asMonoMs(2_000 + i));
    expect(monitor.status(asMonoMs(2_100)).verdict).toBe('ok');
  });
});

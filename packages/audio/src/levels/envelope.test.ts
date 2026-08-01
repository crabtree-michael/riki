import { describe, expect, it } from 'vitest';
import { EnvelopeFollower, fromDbfs, rms, toDbfs } from './envelope.js';
import { LevelPump } from './pump.js';
import { SilenceDetector } from './silence.js';
import { generateSilence, generateTone } from '../testing/index.js';

const RATE = 24_000;

describe('rms', () => {
  it('is amplitude/√2 for a sine', () => {
    const tone = generateTone({ frequency: 440, sampleRate: RATE, durationMs: 100, amplitude: 1 });
    expect(rms(tone)).toBeCloseTo(1 / Math.SQRT2, 2);
  });

  it('is zero for silence and for an empty frame', () => {
    expect(rms(generateSilence(RATE, 10))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe('dbfs', () => {
  it('round-trips', () => {
    expect(toDbfs(fromDbfs(-18))).toBeCloseTo(-18, 6);
  });

  it('floors digital silence instead of returning -Infinity', () => {
    expect(toDbfs(0)).toBe(-100);
    expect(Number.isFinite(toDbfs(0))).toBe(true);
  });
});

describe('EnvelopeFollower', () => {
  const loud = generateTone({ frequency: 440, sampleRate: RATE, durationMs: 10, amplitude: 0.5 });
  const quiet = generateSilence(RATE, 10);

  it('rises within a couple of frames — a syllable must register immediately', () => {
    const follower = new EnvelopeFollower();
    follower.push(loud, 10);
    follower.push(loud, 10);
    expect(follower.value).toBeGreaterThan(0.5);
  });

  it('falls more slowly than it rises, so the bars do not strobe between words', () => {
    const fast = new EnvelopeFollower();
    for (let i = 0; i < 20; i += 1) fast.push(loud, 10);
    const peak = fast.value;

    fast.push(quiet, 10);
    const afterOneQuietFrame = fast.value;

    // One 10 ms frame of silence against a 180 ms release must barely move it.
    expect(afterOneQuietFrame).toBeGreaterThan(peak * 0.85);
  });

  it('eventually reaches zero rather than resting on a floating-point residue', () => {
    const follower = new EnvelopeFollower();
    follower.push(loud, 10);
    for (let i = 0; i < 500; i += 1) follower.push(quiet, 10);
    expect(follower.value).toBe(0);
  });

  it('maps on a dB scale, so ordinary speech uses the middle of the bar', () => {
    // −24 dBFS is unremarkable speech. On a linear mapping it would sit at 0.06 of full scale
    // and users would conclude the mic was dead.
    const follower = new EnvelopeFollower();
    const speech = generateTone({
      frequency: 440,
      sampleRate: RATE,
      durationMs: 10,
      amplitude: fromDbfs(-24) * Math.SQRT2,
    });
    for (let i = 0; i < 50; i += 1) follower.push(speech, 10);
    expect(follower.value).toBeGreaterThan(0.5);
    expect(follower.value).toBeLessThan(0.8);
  });

  it('is rate-independent — the same signal reaches the same level per unit of wall time', () => {
    const coarse = new EnvelopeFollower();
    const fine = new EnvelopeFollower();
    for (let i = 0; i < 10; i += 1) coarse.push(loud, 10);
    for (let i = 0; i < 100; i += 1) fine.push(loud, 1);
    expect(fine.value).toBeCloseTo(coarse.value, 2);
  });

  it('tolerates a zero dt without dividing by zero', () => {
    const follower = new EnvelopeFollower();
    expect(() => follower.push(loud, 0)).not.toThrow();
    expect(Number.isFinite(follower.value)).toBe(true);
  });
});

describe('LevelPump', () => {
  const loud = generateTone({ frequency: 440, sampleRate: RATE, durationMs: 10, amplitude: 0.5 });
  const quiet = generateSilence(RATE, 10);

  it('emits nothing at all while stopped — "idle costs literally nothing"', () => {
    const pump = new LevelPump();
    const samples: number[] = [];
    pump.onSample((sample) => samples.push(sample.value));
    for (let i = 0; i < 100; i += 1) pump.push(loud, i * 10);
    expect(samples).toEqual([]);
  });

  it('throttles to 30 fps rather than to the audio callback rate', () => {
    const pump = new LevelPump();
    const samples: number[] = [];
    pump.onSample((sample) => samples.push(sample.value));
    pump.setRunning(true, 'input');

    // 1 s of 2.5 ms chunks: 400 pushes, which at 30 fps is ~30 frames.
    for (let i = 0; i < 400; i += 1) pump.push(loud, i * 2.5);

    expect(samples.length).toBeGreaterThan(25);
    expect(samples.length).toBeLessThan(35);
  });

  it('carries the source, so the chip knows whether it is showing input or output', () => {
    const pump = new LevelPump();
    const sources: string[] = [];
    pump.onSample((sample) => sources.push(sample.source));
    pump.setRunning(true, 'output');
    pump.pushLevel(0.8, 0);
    expect(sources).toEqual(['output']);
  });

  it('resets on stop so the bars do not resume from a stale height', () => {
    const pump = new LevelPump();
    pump.setRunning(true, 'input');
    for (let i = 0; i < 50; i += 1) pump.push(loud, i * 10);
    expect(pump.push(loud, 500)).toBeGreaterThan(0.8);
    pump.setRunning(false);

    // Silence on restart: with a stale envelope the bars would open at the previous height and
    // decay, which reads as "it heard something" when it heard nothing. The fast attack means
    // pushing a *loud* frame here would rise immediately either way and prove nothing.
    const samples: number[] = [];
    pump.onSample((sample) => samples.push(sample.value));
    pump.setRunning(true, 'input');
    pump.push(quiet, 1000);
    expect(samples[0] ?? 1).toBeLessThan(0.05);
  });
});

describe('SilenceDetector', () => {
  it('does not fire on the gap between two words', () => {
    const detector = new SilenceDetector({ holdMs: 250 });
    const events: string[] = [];
    detector.onEvent((event) => events.push(event));

    detector.push(0.5, 0);
    // A 150 ms inter-word gap, shorter than the hold.
    for (let t = 10; t <= 150; t += 10) detector.push(0.01, t);
    detector.push(0.5, 160);

    expect(events).toEqual([]);
  });

  it('fires once the level stays down past the hold', () => {
    const detector = new SilenceDetector({ holdMs: 250 });
    const events: string[] = [];
    detector.onEvent((event) => events.push(event));

    detector.push(0.5, 0);
    for (let t = 10; t <= 400; t += 10) detector.push(0.01, t);

    expect(events).toEqual(['silence']);
  });

  it('reports resumption exactly once', () => {
    const detector = new SilenceDetector({ holdMs: 100 });
    const events: string[] = [];
    detector.onEvent((event) => events.push(event));

    for (let t = 0; t <= 300; t += 10) detector.push(0.01, t);
    detector.push(0.5, 310);
    detector.push(0.5, 320);

    expect(events).toEqual(['silence', 'resumed']);
  });

  it('starts a new turn as speaking, not as silence', () => {
    const detector = new SilenceDetector({ holdMs: 100 });
    for (let t = 0; t <= 300; t += 10) detector.push(0.01, t);
    expect(detector.silent).toBe(true);
    detector.reset();
    expect(detector.silent).toBe(false);
  });
});

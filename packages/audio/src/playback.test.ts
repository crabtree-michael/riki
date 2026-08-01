/**
 * The guarding test REPO_SKELETON.md §5.4 asks for — "on simulated interruption, assert a truncate
 * event was sent with a plausible `audio_end_ms`" — from the measurement side. The send side is
 * `packages/realtime`'s.
 *
 * "Plausible" is the whole assertion. Too high and the model believes it said things the player
 * never heard; too low and it repeats itself. Either way every later turn is built on a false
 * premise (openai-realtime-research.md §4).
 */

import { describe, expect, it } from 'vitest';
import {
  accumulate,
  createPlaybackTracker,
  DEFAULT_PLAYBACK_OPTIONS,
  type RemoteAnalyser,
} from './playback.js';
import { generateSilence, generateTone } from './testing/index.js';
import type { Clock, ItemId, MonoMs, ResponseId, Unsubscribe } from './types.js';

const RATE = 24_000;
const FRAME_MS = DEFAULT_PLAYBACK_OPTIONS.frameMs;

const responseId = 'resp_1' as ResponseId;
const itemId = 'item_1' as ItemId;

/** One 33 ms frame of speech-level audio, and one of silence. */
const SPEECH = generateTone({ hz: 440, sampleRate: RATE, durationMs: FRAME_MS, amplitude: 0.4 });
const SILENCE = generateSilence(RATE, FRAME_MS);

function harness() {
  let now = 0;
  const clock: Clock = { now: () => now as MonoMs };
  let emit: ((frame: Float32Array, at: MonoMs) => void) | null = null;

  const analyser: RemoteAnalyser = {
    onFrame: (listener): Unsubscribe => {
      emit = listener;
      return () => {
        emit = null;
      };
    },
    dispose: () => {
      emit = null;
    },
  };

  const tracker = createPlaybackTracker({ clock, analyserFor: () => analyser });
  tracker.attach({ id: 'remote' });

  return {
    tracker,
    /** Feed n frames, advancing the clock as playback would. An arrow so it survives destructuring. */
    play: (frame: Float32Array, count: number): void => {
      for (let i = 0; i < count; i += 1) {
        now += FRAME_MS;
        emit?.(frame, now as MonoMs);
      }
    },
  };
}

describe('accumulate — the pure half', () => {
  it('counts a frame above the floor and not one below it', () => {
    const zero = { audibleMs: 0, level: 0 };
    expect(accumulate(zero, SPEECH, DEFAULT_PLAYBACK_OPTIONS).audibleMs).toBeCloseTo(FRAME_MS, 6);
    expect(accumulate(zero, SILENCE, DEFAULT_PLAYBACK_OPTIONS).audibleMs).toBe(0);
  });

  it('excludes trailing silence, which is the point of a floor', () => {
    // Counting generated-but-silent audio inflates audio_end_ms past what was actually said.
    let state = { audibleMs: 0, level: 0 };
    for (let i = 0; i < 10; i += 1) state = accumulate(state, SPEECH, DEFAULT_PLAYBACK_OPTIONS);
    for (let i = 0; i < 10; i += 1) state = accumulate(state, SILENCE, DEFAULT_PLAYBACK_OPTIONS);
    expect(state.audibleMs).toBeCloseTo(FRAME_MS * 10, 6);
  });
});

describe('measuring a response', () => {
  it('accumulates audible milliseconds while it plays', () => {
    const { tracker, play } = harness();
    tracker.beginResponse(responseId, itemId);
    play(SPEECH, 30);
    // 30 frames of ~33 ms is ~1 s of speech.
    expect(tracker.audibleMs()).toBeCloseTo(FRAME_MS * 30, 3);
  });

  /**
   * **The regression.** The parked implementation started its accounting on
   * `response.output_audio.delta`. That event does not exist on WebRTC — the audio rides the media
   * track (research §2) — so the tracker never started, `audibleMs()` was always zero, and
   * barge-in silently stopped truncating on the *default* transport.
   *
   * There is no wire event anywhere in this file, which is what makes that unreachable. This test
   * is the statement of it: a full, correctly measured response with no audio deltas in play.
   */
  it('measures with no audio-delta events in play at all', () => {
    const { tracker, play } = harness();
    tracker.beginResponse(responseId, itemId);
    play(SPEECH, 18);

    expect(tracker.audibleMs()).toBeGreaterThan(0);
    expect(tracker.audibleMs()).toBeCloseTo(FRAME_MS * 18, 3);

    const report = tracker.endResponse(true);
    expect(report.itemId).toBe(itemId);
    expect(report.interrupted).toBe(true);
    expect(report.audibleMs).toBeCloseTo(FRAME_MS * 18, 3);
  });

  it('gives a mid-response reading, which is what the truncate is sent with', () => {
    const { tracker, play } = harness();
    tracker.beginResponse(responseId, itemId);
    play(SPEECH, 6);
    const atInterrupt = tracker.audibleMs();
    play(SPEECH, 6);

    expect(atInterrupt).toBeCloseTo(FRAME_MS * 6, 3);
    expect(tracker.audibleMs()).toBeGreaterThan(atInterrupt);
  });

  it('resets between responses, so turn two does not inherit turn one', () => {
    const { tracker, play } = harness();
    tracker.beginResponse(responseId, itemId);
    play(SPEECH, 20);
    tracker.endResponse(false);

    tracker.beginResponse('resp_2' as ResponseId, 'item_2' as ItemId);
    expect(tracker.audibleMs()).toBe(0);
    play(SPEECH, 3);
    expect(tracker.audibleMs()).toBeCloseTo(FRAME_MS * 3, 3);
  });

  it('does not accumulate against a response that has ended', () => {
    const { tracker, play } = harness();
    tracker.beginResponse(responseId, itemId);
    play(SPEECH, 5);
    tracker.endResponse(false);
    play(SPEECH, 20);
    expect(tracker.audibleMs()).toBe(0);
  });

  it('reports zero rather than throwing when no response ever began', () => {
    // An ordering race must not cost a turn.
    const { tracker } = harness();
    expect(tracker.endResponse(true).audibleMs).toBe(0);
  });
});

describe('the level signal', () => {
  it('is the same measurement the truncate uses, not a second one', () => {
    const { tracker, play } = harness();
    const samples: number[] = [];
    tracker.onLevel((sample) => samples.push(sample.rms));

    tracker.beginResponse(responseId, itemId);
    play(SPEECH, 10);

    expect(samples).toHaveLength(10);
    expect(samples.at(-1) ?? 0).toBeGreaterThan(0);
  });

  it('decays over silence rather than latching', () => {
    const { tracker, play } = harness();
    const samples: number[] = [];
    tracker.onLevel((sample) => samples.push(sample.rms));

    tracker.beginResponse(responseId, itemId);
    play(SPEECH, 10);
    const peakLevel = samples.at(-1) ?? 0;
    play(SILENCE, 20);

    expect(samples.at(-1) ?? 1).toBeLessThan(peakLevel * 0.2);
  });
});

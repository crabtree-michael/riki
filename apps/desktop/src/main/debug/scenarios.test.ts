/**
 * The script, checked against the two facts it depends on and cannot assert at run time.
 *
 * Both are numbers owned by other packages — `DISCONTINUITY_THRESHOLD_SECONDS` in `@riki/gsi` and
 * `stackLeadSeconds`/`speakThreshold`/`kindWeight.stack_now` in `@riki/events` — so a change to
 * either would otherwise turn this scenario into one that silently proves nothing: a run that
 * resyncs the world model halfway, or one that never crosses the threshold it was aimed at.
 */

import { describe, expect, it, vi } from 'vitest';
import { DISCONTINUITY_THRESHOLD_SECONDS } from '@riki/gsi';
import { DEFAULT_TRIGGER_CONFIG } from '@riki/events';

import { stackWindowScript, runMatchScenario } from './scenarios.js';

const STACK_AT = 53;

function clockOf(frame: { readonly body: Record<string, unknown> }): number {
  const map = frame.body.map as { clock_time: number };
  return map.clock_time;
}

describe('the script', () => {
  it('opens with pre-game, which is what builds the coaching root', () => {
    const [first] = stackWindowScript();
    expect((first?.body.map as { game_state: string }).game_state).toBe(
      'DOTA_GAMERULES_STATE_PRE_GAME',
    );
    expect(clockOf(first!)).toBeLessThan(0);
  });

  /**
   * The one that stops the scenario quietly breaking itself.
   *
   * `packages/gsi`'s session tracker compares each frame's clock against the previous frame
   * extrapolated by wall time; more than the threshold apart is a `clock_discontinuity`, and a
   * discontinuity resyncs the world model — clearing the latch set and the cooldown clocks the run
   * exists to exercise. Compressing the script further is the obvious "make the button faster"
   * change, and this is the test that says why it cannot be.
   */
  it('never drifts more than the discontinuity threshold between frames', () => {
    const frames = stackWindowScript();

    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1]!;
      const current = frames[index]!;
      const elapsedSeconds = (current.atMs - previous.atMs) / 1_000;
      const drift = clockOf(current) - clockOf(previous) - elapsedSeconds;
      expect(Math.abs(drift)).toBeLessThan(DISCONTINUITY_THRESHOLD_SECONDS);
    }
  });

  /**
   * The run must actually reach a salience above `speakThreshold`, or it proves nothing.
   *
   * The arithmetic is `packages/events`': salience is `kindWeight × magnitude × urgency ×
   * confidence`, and urgency is `horizon / (horizon + (deadline − speakLatency))`. Magnitude and
   * confidence are 1 for a clock-derived detection.
   */
  it('walks the clock through a frame where stack_now can outscore the threshold', () => {
    const cfg = DEFAULT_TRIGGER_CONFIG;
    const best = stackWindowScript()
      .map((frame) => STACK_AT - clockOf(frame))
      .filter((until) => until > 0 && until <= cfg.stackLeadSeconds)
      .map((until) => {
        const effective = until - cfg.speakLatencySeconds;
        const urgency =
          effective <= 0 ? 0 : cfg.urgencyHorizonSeconds / (cfg.urgencyHorizonSeconds + effective);
        return cfg.kindWeight.stack_now * urgency;
      })
      .reduce((a, b) => Math.max(a, b), 0);

    expect(best).toBeGreaterThan(cfg.speakThreshold);
  });

  /**
   * The notes are the run's captions, and a caption keyed on an equality that cannot hold is a
   * silent nothing. The first draft tested `until === 12` while every frame's `until` was odd.
   */
  it('actually emits every note it defines', () => {
    const notes = stackWindowScript()
      .map((frame) => frame.note)
      .filter((note): note is string => note !== null);

    expect(notes).toHaveLength(4);
    expect(notes[0]).toContain('pre-game');
    expect(notes[1]).toContain('horn');
    expect(notes[2]).toContain('starts detecting');
    expect(notes[3]).toContain('crosses speakThreshold');
  });

  it('posts one match id throughout, so the run is one match and not several', () => {
    const ids = new Set(
      stackWindowScript().map((frame) => (frame.body.map as { matchid: string }).matchid),
    );
    expect(ids.size).toBe(1);
  });
});

describe('running it', () => {
  it('posts every frame in order and traces the notes', async () => {
    const posted: number[] = [];
    const steps: string[] = [];

    await runMatchScenario({
      post: (body) => {
        posted.push((body.map as { clock_time: number }).clock_time);
        return Promise.resolve(200);
      },
      sleep: () => Promise.resolve(),
      trace: (_stage, message) => steps.push(message),
    });

    expect(posted).toEqual(stackWindowScript().map(clockOf));
    expect(steps.at(-1)).toContain('frames posted');
  });

  /**
   * A GSI server that refuses is the failure this scenario is most likely to hit — a stale token,
   * a port already bound — and a run that carried on posting into a 403 would fill the trace with
   * frames while proving nothing.
   */
  it('stops at the first non-200 and says so, rather than posting into a refusal', async () => {
    const post = vi.fn(() => Promise.resolve(403));
    const steps: { stage: string; message: string }[] = [];

    await runMatchScenario({
      post,
      sleep: () => Promise.resolve(),
      trace: (stage, message) => steps.push({ stage, message }),
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(steps).toEqual([{ stage: 'fault', message: expect.stringContaining('403') as string }]);
  });
});

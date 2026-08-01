import { describe, expect, it } from 'vitest';

import { FRAME_INTERVAL_MS, createLevelPump } from './level-pump.js';
import type { LevelFrame, LevelSource } from '../../shared/overlay.js';

function harness() {
  const sent: LevelFrame[] = [];
  let now = 0;
  const pump = createLevelPump({ now: () => now, send: (frame) => void sent.push(frame) });
  const frame = (source: LevelSource, value = 0.5): LevelFrame => ({
    source,
    value,
    at: now,
    revision: 1,
  });
  return { pump, sent, frame, tick: (ms: number) => (now += ms) };
}

describe('createLevelPump', () => {
  it('sends nothing until started', () => {
    const { pump, sent, frame } = harness();
    pump.onFrame(frame('input'));
    expect(sent).toEqual([]);
    expect(pump.isRunning()).toBe(false);
  });

  it('passes the first frame straight through', () => {
    const { pump, sent, frame } = harness();
    pump.start('input');
    pump.onFrame(frame('input', 0.4));
    expect(sent).toHaveLength(1);
  });

  it('coalesces to roughly 30 Hz', () => {
    const { pump, sent, frame, tick } = harness();
    pump.start('input');

    // 100 frames at 200 Hz — a full second of a source running far faster than the chip needs.
    for (let i = 0; i < 200; i += 1) {
      pump.onFrame(frame('input'));
      tick(5);
    }

    expect(sent.length).toBeLessThanOrEqual(Math.ceil(1_000 / FRAME_INTERVAL_MS) + 1);
    expect(sent.length).toBeGreaterThan(25);
  });

  it('drops frames for a source it is no longer showing', () => {
    const { pump, sent, frame, tick } = harness();
    pump.start('input');
    tick(100);
    pump.onFrame(frame('output'));
    expect(sent).toEqual([]);
  });

  it('lets the first frame of a new source through immediately after barge-in', () => {
    const { pump, sent, frame, tick } = harness();
    pump.start('output');
    pump.onFrame(frame('output'));
    tick(1);

    pump.start('input');
    pump.onFrame(frame('input'));

    // Not throttled behind the previous turn: the input meter has 250 ms to respond in total.
    expect(sent).toHaveLength(2);
    expect(sent.at(-1)?.source).toBe('input');
  });

  it('goes quiet on stop, which is how a hidden overlay costs no IPC at all', () => {
    const { pump, sent, frame, tick } = harness();
    pump.start('input');
    pump.onFrame(frame('input'));
    pump.stop();

    tick(1_000);
    pump.onFrame(frame('input'));

    expect(sent).toHaveLength(1);
    expect(pump.isRunning()).toBe(false);
  });
});

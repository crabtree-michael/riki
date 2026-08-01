import { describe, expect, it } from 'vitest';

import { FRAME_INTERVAL_MS, createAnimationClock } from './clock.js';

/** A host that calls back at whatever rate the test asks for — no browser, no display. */
function host(stepMs: number) {
  let handle = 0;
  let now = 0;
  const pending = new Map<number, (t: number) => void>();

  return {
    deps: {
      requestFrame: (fn: (t: number) => void) => {
        handle += 1;
        pending.set(handle, fn);
        return handle;
      },
      cancelFrame: (id: number) => void pending.delete(id),
    },
    /** Drives `count` host frames at the host's own rate. */
    run(count: number) {
      for (let i = 0; i < count; i += 1) {
        now += stepMs;
        const next = [...pending.entries()][0];
        if (next === undefined) return;
        pending.delete(next[0]);
        next[1](now);
      }
    },
    pendingCount: () => pending.size,
  };
}

describe('createAnimationClock', () => {
  it('drops a 144 Hz host down to about 30 fps', () => {
    const gaming = host(1_000 / 144);
    const clock = createAnimationClock(gaming.deps);

    const ticks: number[] = [];
    clock.subscribe((t) => ticks.push(t));
    clock.start();
    gaming.run(144); // one second of host frames

    expect(ticks.length).toBeLessThanOrEqual(Math.ceil(1_000 / FRAME_INTERVAL_MS) + 1);
    expect(ticks.length).toBeGreaterThan(25);
  });

  it('reports elapsed time from the start, not the host timestamp', () => {
    const gaming = host(16);
    const clock = createAnimationClock(gaming.deps);
    const ticks: number[] = [];
    clock.subscribe((t) => ticks.push(t));

    clock.start();
    gaming.run(10);

    expect(ticks[0]).toBe(0);
    expect(ticks.every((t) => t >= 0)).toBe(true);
  });

  it('counts the frames it rendered, which is how idle is asserted', () => {
    const gaming = host(16);
    const clock = createAnimationClock(gaming.deps);
    clock.start();
    gaming.run(20);

    const rendered = clock.framesRendered();
    expect(rendered).toBeGreaterThan(0);

    clock.stop();
    gaming.run(60);
    expect(clock.framesRendered()).toBe(rendered);
  });

  it('requests no further frames once stopped', () => {
    const gaming = host(16);
    const clock = createAnimationClock(gaming.deps);
    clock.start();
    gaming.run(4);
    clock.stop();

    expect(clock.isRunning()).toBe(false);
    expect(gaming.pendingCount()).toBe(0);
  });

  it('is idempotent, so a state change that does not stop it does not double it', () => {
    const gaming = host(16);
    const clock = createAnimationClock(gaming.deps);
    clock.start();
    clock.start();
    gaming.run(1);
    expect(gaming.pendingCount()).toBe(1);

    clock.stop();
    clock.stop();
    expect(clock.isRunning()).toBe(false);
  });

  it('restarts its clock, so the next state animates from its own zero', () => {
    const gaming = host(50);
    const clock = createAnimationClock(gaming.deps);
    const ticks: number[] = [];
    clock.subscribe((t) => ticks.push(t));

    clock.start();
    gaming.run(4);
    clock.stop();
    const before = ticks.length;

    clock.start();
    gaming.run(1);
    expect(ticks[before]).toBe(0);
  });

  it('stops delivering to a subscriber that has unsubscribed', () => {
    const gaming = host(50);
    const clock = createAnimationClock(gaming.deps);
    let seen = 0;
    const off = clock.subscribe(() => (seen += 1));

    clock.start();
    gaming.run(2);
    const before = seen;
    off();
    gaming.run(4);

    expect(seen).toBe(before);
  });
});

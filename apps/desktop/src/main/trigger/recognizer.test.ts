/**
 * The 250 ms threshold, and the gesture that hangs off it — ui-design.md §6.2.
 *
 * The whole reason `GestureRecognizer` is a seam is that this number needs a test and testing it
 * should not require a keyboard. So every case here is three function calls and an array
 * comparison, and none of them waits for real time.
 */

import { describe, expect, it } from 'vitest';
import { HOLD_THRESHOLD_MS, createGestureRecognizer } from './recognizer.js';
import { createTriggerPump, type KeySource } from './index.js';
import type { Millis } from '../../shared/overlay.js';
import type { TriggerEvent } from '../session/types.js';

const kinds = (events: readonly TriggerEvent[]): readonly string[] => events.map((e) => e.kind);

describe('tap versus hold', () => {
  it('a release before the threshold is a tap, and a tap is what latches', () => {
    const recognizer = createGestureRecognizer();

    expect(kinds(recognizer.keyDown(0))).toEqual([]);
    expect(kinds(recognizer.keyUp(HOLD_THRESHOLD_MS - 1))).toEqual(['tap']);
  });

  it('the threshold expiring is the push, and the release ends it', () => {
    const recognizer = createGestureRecognizer();

    recognizer.keyDown(0);
    expect(kinds(recognizer.tick(HOLD_THRESHOLD_MS - 1))).toEqual([]);
    expect(kinds(recognizer.tick(HOLD_THRESHOLD_MS))).toEqual(['down']);
    expect(kinds(recognizer.keyUp(900))).toEqual(['up']);
  });

  it('exactly at the threshold is a hold, not a tap', () => {
    const recognizer = createGestureRecognizer();

    recognizer.keyDown(0);
    // No tick in between: the boundary has to be the same on both paths, or a coarse timer
    // silently changes which gesture a given press is.
    expect(kinds(recognizer.keyUp(HOLD_THRESHOLD_MS))).toEqual(['down', 'up']);
  });

  it('emits both edges when the release beats the tick, so the press is never half-reported', () => {
    const recognizer = createGestureRecognizer();

    recognizer.keyDown(0);
    expect(kinds(recognizer.keyUp(5_000))).toEqual(['down', 'up']);
    // And the tick that arrives afterwards has nothing left to say.
    expect(kinds(recognizer.tick(5_001))).toEqual([]);
  });

  it('honours an injected threshold, because it is a setting', () => {
    const recognizer = createGestureRecognizer({ holdThresholdMs: 100 });

    recognizer.keyDown(0);
    expect(kinds(recognizer.tick(100))).toEqual(['down']);
  });
});

describe('latching', () => {
  it('ends a latch with a second tap', () => {
    const recognizer = createGestureRecognizer();

    recognizer.keyDown(0);
    expect(kinds(recognizer.keyUp(50))).toEqual(['tap']);

    recognizer.keyDown(900);
    expect(kinds(recognizer.keyUp(950))).toEqual(['tap']);
  });

  it('ignores the release of the press that latched', () => {
    const recognizer = createGestureRecognizer();

    recognizer.keyDown(0);
    recognizer.keyUp(50);
    // A key source that reports both edges of the same physical press.
    expect(kinds(recognizer.keyUp(51))).toEqual([]);
  });

  it('resets on demand, because a latch also ends on silence, Esc and a fault', () => {
    const recognizer = createGestureRecognizer();

    recognizer.keyDown(0);
    recognizer.keyUp(50);
    recognizer.reset();

    // Back to a first gesture: a quick press starts a new latch rather than ending a dead one.
    recognizer.keyDown(900);
    expect(kinds(recognizer.keyUp(950))).toEqual(['tap']);
  });
});

describe('key repeat', () => {
  it('does not restart the threshold, or a held key would never decide', () => {
    const recognizer = createGestureRecognizer();

    recognizer.keyDown(0);
    recognizer.keyDown(100);
    recognizer.keyDown(200);
    // Measured from the first edge, not the last: at 250 the gesture is a push either way.
    expect(kinds(recognizer.tick(HOLD_THRESHOLD_MS))).toEqual(['down']);
  });
});

// -------------------------------------------------------------------------------------------

interface FakeKeys extends KeySource {
  press(now: Millis): void;
  release(now: Millis): void;
  readonly bound: boolean;
}

function fakeKeys(canBind = true): FakeKeys {
  const down = new Set<(now: Millis) => void>();
  const up = new Set<(now: Millis) => void>();
  let bound = false;

  return {
    hasKeyUp: true,
    get bound() {
      return bound;
    },
    bind: () => {
      bound = canBind;
      return canBind;
    },
    unbind: () => {
      bound = false;
    },
    onKeyDown: (fn) => {
      down.add(fn);
      return () => down.delete(fn);
    },
    onKeyUp: (fn) => {
      up.add(fn);
      return () => up.delete(fn);
    },
    onCancel: () => () => undefined,
    press: (now) => {
      for (const fn of [...down]) fn(now);
    },
    release: (now) => {
      for (const fn of [...up]) fn(now);
    },
  };
}

describe('the pump', () => {
  /** A timer a test fires by hand: the pump's whole job is to schedule the threshold tick. */
  function manualTimers() {
    const pending: { at: number; fn: () => void }[] = [];
    return {
      after: (ms: number, fn: () => void) => {
        const entry = { at: ms, fn };
        pending.push(entry);
        return (): void => {
          const index = pending.indexOf(entry);
          if (index !== -1) pending.splice(index, 1);
        };
      },
      fire: () => {
        const next = pending.shift();
        next?.fn();
      },
      get depth() {
        return pending.length;
      },
    };
  }

  it('turns a held key into `down` when the threshold tick fires', () => {
    const keys = fakeKeys();
    const timers = manualTimers();
    const dispatched: TriggerEvent[] = [];
    let now = 0;

    const pump = createTriggerPump({
      keys,
      recognizer: createGestureRecognizer(),
      now: () => now,
      after: timers.after,
      dispatch: (event) => dispatched.push(event),
    });
    expect(pump.start()).toBe(true);

    keys.press(0);
    expect(dispatched).toEqual([]);

    now = HOLD_THRESHOLD_MS;
    timers.fire();
    expect(kinds(dispatched)).toEqual(['down']);

    keys.release(400);
    expect(kinds(dispatched)).toEqual(['down', 'up']);
  });

  it('cancels the tick on release, so a tap never also produces a `down`', () => {
    const keys = fakeKeys();
    const timers = manualTimers();
    const dispatched: TriggerEvent[] = [];

    createTriggerPump({
      keys,
      recognizer: createGestureRecognizer(),
      now: () => 0,
      after: timers.after,
      dispatch: (event) => dispatched.push(event),
    }).start();

    keys.press(0);
    keys.release(50);
    expect(kinds(dispatched)).toEqual(['tap']);
    expect(timers.depth).toBe(0);
  });

  it('reports a hotkey it could not bind rather than pretending', () => {
    const keys = fakeKeys(false);
    const timers = manualTimers();

    const pump = createTriggerPump({
      keys,
      recognizer: createGestureRecognizer(),
      now: () => 0,
      after: timers.after,
      dispatch: () => undefined,
    });

    expect(pump.start()).toBe(false);
  });
});

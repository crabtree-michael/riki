/**
 * The frame pump and the window's lifetime.
 *
 * `createDebugSurface` is the only stateful thing in the component that is not the hub, and what it
 * owns is a self-re-arming timer pointed at a window that may or may not exist. Two of the
 * component's three headline claims live here rather than in `hub.ts`:
 *
 * - **It costs nothing when nobody is looking.** The pump must not run — and must not even be armed
 *   — while the window is closed. `hub.frame()` walks the whole world model, so a pump left running
 *   behind a closed window is precisely the cost debug-inspector.md §5 says a debug tool must not
 *   impose on the thing it is measuring.
 * - **`windows` being absent means collect-but-do-not-display.** That is the shape `shell.test.ts`
 *   runs in and the shape a headless `pnpm dev:replay` would use, so `nullDebugWindow` must be inert
 *   in the specific way `open()` guards for: arming a timer that re-arms itself forever with nowhere
 *   to send a frame would be an infinite loop in the configuration the test suite uses most.
 *
 * Both are driven through injected `Timers` and an injected `DebugWindowFactory`, so none of this
 * needs Electron — which is the same reason `DebugSurfaceDeps.windows` is optional in the first
 * place.
 */

import { describe, expect, it } from 'vitest';

import type { Timers } from '@riki/context';

import type { DebugCommand, DebugIntent } from '../../shared/debug.js';
import { DEBUG_FRAME_INTERVAL_MS } from '../../shared/debug.js';
import type { DebugWindow, DebugWindowFactory } from './contracts.js';
import { createDebugComponent, createDebugSurface, nullDebugWindow } from './index.js';
import { createDebugHub } from './hub.js';

/** A timer wheel with one slot, which is all the pump uses: it re-arms from inside its own callback. */
function manualTimers(): Timers & { fire(): void; readonly armed: boolean } {
  let pending: (() => void) | null = null;
  return {
    after(_ms: number, fn: () => void): () => void {
      pending = fn;
      return () => {
        if (pending === fn) pending = null;
      };
    },
    fire(): void {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get armed(): boolean {
      return pending !== null;
    },
  };
}

interface FakeWindow extends DebugWindow {
  readonly sent: DebugCommand[];
  emitIntent(intent: DebugIntent): void;
  emitClosed(): void;
  readonly destroyed: boolean;
}

function fakeWindow(): FakeWindow {
  const sent: DebugCommand[] = [];
  const intents = new Set<(intent: DebugIntent) => void>();
  const closers = new Set<() => void>();
  let open = false;
  let destroyed = false;

  return {
    sent,
    open: (): Promise<void> => {
      open = true;
      return Promise.resolve();
    },
    close: (): void => {
      open = false;
      for (const fn of [...closers]) fn();
    },
    isOpen: () => open,
    send: (command): void => {
      sent.push(command);
    },
    onIntent: (fn) => {
      intents.add(fn);
      return () => intents.delete(fn);
    },
    onClosed: (fn) => {
      closers.add(fn);
      return () => closers.delete(fn);
    },
    destroy: (): void => {
      destroyed = true;
      open = false;
    },
    emitIntent: (intent): void => {
      for (const fn of [...intents]) fn(intent);
    },
    emitClosed: (): void => {
      for (const fn of [...closers]) fn();
    },
    get destroyed(): boolean {
      return destroyed;
    },
  };
}

function surfaceWith(window: FakeWindow, timers: ReturnType<typeof manualTimers>) {
  const windows: DebugWindowFactory = { create: () => window };
  const hub = createDebugHub();
  return {
    hub,
    surface: createDebugSurface({ hub, windows, timers, now: () => 1_000 }),
  };
}

function frames(window: FakeWindow): DebugCommand[] {
  return window.sent.filter((command) => command.kind === 'frame');
}

describe('the frame pump', () => {
  it('sends nothing, and arms nothing, before the window is opened', () => {
    const window = fakeWindow();
    const timers = manualTimers();
    surfaceWith(window, timers);

    expect(window.sent).toHaveLength(0);
    expect(timers.armed).toBe(false);
  });

  it('sends a frame on open and re-arms itself', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    await surface.open();
    expect(frames(window)).toHaveLength(1);
    expect(timers.armed).toBe(true);

    timers.fire();
    expect(frames(window)).toHaveLength(2);
    // Re-armed from inside the callback rather than on an interval, so a slow frame cannot queue
    // behind itself.
    expect(timers.armed).toBe(true);
  });

  it('advances the revision, so the renderer can drop a frame it has already drawn', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    await surface.open();
    timers.fire();

    const sent = frames(window);
    const first = sent[0];
    const second = sent[1];
    if (first?.kind !== 'frame' || second?.kind !== 'frame') throw new Error('expected two frames');
    expect(second.frame.revision).toBeGreaterThan(first.frame.revision);
  });

  it('stops when the window is closed by the user', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    await surface.open();
    const before = frames(window).length;

    window.close();
    expect(timers.armed).toBe(false);

    timers.fire();
    expect(frames(window)).toHaveLength(before);
  });

  it('stops when closed through the surface', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    await surface.open();
    surface.close();

    expect(timers.armed).toBe(false);
    expect(surface.isOpen()).toBe(false);
  });

  it('resumes on reopen rather than staying dead', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    await surface.open();
    surface.close();
    await surface.open();

    expect(timers.armed).toBe(true);
    const before = frames(window).length;
    timers.fire();
    expect(frames(window).length).toBeGreaterThan(before);
  });

  it('does not arm a second pump when open is called twice', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    await surface.open();
    await surface.open();

    // One slot, so a second pump would be invisible here — but it would also double the frame rate,
    // which is observable.
    const before = frames(window).length;
    timers.fire();
    expect(frames(window)).toHaveLength(before + 1);
  });

  it('uses the shared interval so main and the renderer agree about "live"', async () => {
    const window = fakeWindow();
    let requested: number | null = null;
    const timers: Timers = {
      after(ms: number): () => void {
        requested = ms;
        return () => undefined;
      },
    };
    const surface = createDebugSurface({
      hub: createDebugHub(),
      windows: { create: () => window },
      timers,
      now: () => 0,
    });

    await surface.open();
    expect(requested).toBe(DEBUG_FRAME_INTERVAL_MS);
  });
});

describe('intents from the renderer', () => {
  it('answers ready with a frame immediately, rather than making a remount wait out the interval', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    await surface.open();
    const before = frames(window).length;

    window.emitIntent({ kind: 'ready' });
    expect(frames(window)).toHaveLength(before + 1);
  });

  it('ignores ready while the window is closed', () => {
    const window = fakeWindow();
    const timers = manualTimers();
    surfaceWith(window, timers);

    window.emitIntent({ kind: 'ready' });
    expect(frames(window)).toHaveLength(0);
  });

  it('records a renderer fault as a problem, since the inspector has no other way to speak', () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { hub } = surfaceWith(window, timers);

    window.emitIntent({ kind: 'fault', message: 'view threw while drawing' });

    const problems = hub.frame(2_000).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]?.origin).toBe('inspector');
    expect(problems[0]?.message).toBe('view threw while drawing');
  });
});

describe('dispose', () => {
  it('tells the renderer to stop drawing, then tears the window down', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    await surface.open();
    surface.dispose();

    expect(window.sent.at(-1)).toEqual({ kind: 'teardown' });
    expect(window.destroyed).toBe(true);
    expect(timers.armed).toBe(false);
  });

  it('is idempotent, and stays inert afterwards', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const { surface } = surfaceWith(window, timers);

    surface.dispose();
    surface.dispose();
    await surface.open();

    expect(frames(window)).toHaveLength(0);
    expect(timers.armed).toBe(false);
  });
});

describe('with no window factory', () => {
  it('collects without displaying, and never arms a pump', async () => {
    // The shape `shell.test.ts` runs in and the one a headless replay would use. `open()` is gated
    // on `isOpen()` for exactly this: `nullDebugWindow` is never open, so a pump armed here would
    // re-arm itself forever with nowhere to send a frame.
    const timers = manualTimers();
    const surface = createDebugComponent({ timers, now: () => 1_000 });

    await surface.open();

    expect(timers.armed).toBe(false);
    expect(surface.isOpen()).toBe(false);
    // The hub still collects: that is the whole point of the configuration.
    surface.hub.recordProblem('sidecar', 'panicked', 1_000);
    expect(surface.hub.frame(1_000).problems).toHaveLength(1);
  });

  it('has a null window that answers every method', () => {
    const window = nullDebugWindow();
    expect(window.isOpen()).toBe(false);
    expect(() => {
      window.send({ kind: 'teardown' });
      window.close();
      window.destroy();
      window.onIntent(() => undefined)();
      window.onClosed(() => undefined)();
    }).not.toThrow();
  });
});

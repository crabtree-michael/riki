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
import type { DebugControlPort } from './controls.js';
import type { DebugRehearsalPort, RehearsalOutcome } from './rehearsal.js';
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

describe('control intents (ADR-0037)', () => {
  /** A port that records what it was asked and answers however the test wants. */
  function fakePort(ok = true): DebugControlPort & {
    readonly applied: { id: string; value: unknown }[];
    resets: number;
  } {
    const applied: { id: string; value: unknown }[] = [];
    return {
      applied,
      resets: 0,
      list: () => [],
      apply(id, value) {
        applied.push({ id, value });
        return ok ? { ok: true, reason: null } : { ok: false, reason: 'locked' };
      },
      reset(): void {
        this.resets += 1;
      },
    };
  }

  it('forwards a change to the port and answers with a frame immediately', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const controls = fakePort();
    const hub = createDebugHub();
    const surface = createDebugSurface({
      hub,
      windows: { create: () => window },
      controls,
      timers,
      now: () => 1_000,
    });

    await surface.open();
    const before = frames(window).length;

    window.emitIntent({ kind: 'control', id: 'trigger.speakThreshold', value: 0.05 });

    expect(controls.applied).toEqual([{ id: 'trigger.speakThreshold', value: 0.05 }]);
    // Not on the next tick of the pump. A control whose value visibly lags the click by up to
    // 250 ms reads as a control that did not work, and the first thing anybody does with one of
    // those is click it again.
    expect(frames(window).length).toBe(before + 1);
  });

  it('forwards a reset', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const controls = fakePort();
    const surface = createDebugSurface({
      hub: createDebugHub(),
      windows: { create: () => window },
      controls,
      timers,
      now: () => 1_000,
    });

    await surface.open();
    window.emitIntent({ kind: 'reset-controls' });

    expect(controls.resets).toBe(1);
  });

  it('records a refusal as an inspector problem rather than swallowing it', () => {
    const window = fakeWindow();
    const hub = createDebugHub();
    createDebugSurface({
      hub,
      windows: { create: () => window },
      controls: fakePort(false),
      timers: manualTimers(),
      now: () => 1_000,
    });

    window.emitIntent({ kind: 'control', id: 'gate.muted', value: false });

    const problems = hub.frame(1_000).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]?.origin).toBe('inspector');
    expect(problems[0]?.message).toContain('gate.muted');
    expect(problems[0]?.message).toContain('locked');
  });

  it('says so when there is no control port at all', () => {
    // A headless replay, or any surface built before this port existed. The panel is drawn from
    // `DebugSources.controls`, so a window that could show controls but not move them has to
    // report that somewhere rather than looking broken.
    const window = fakeWindow();
    const hub = createDebugHub();
    createDebugSurface({
      hub,
      windows: { create: () => window },
      timers: manualTimers(),
      now: () => 1_000,
    });

    window.emitIntent({ kind: 'control', id: 'trigger.speakThreshold', value: 0.05 });

    expect(hub.frame(1_000).problems[0]?.message).toContain('no control port');
  });
});

describe('rehearse intents (ADR-0038)', () => {
  /** A port that answers when the test lets it, so the non-blocking claim can be observed. */
  function fakeRehearsal(): DebugRehearsalPort & {
    readonly asked: string[];
    settle(outcome?: RehearsalOutcome): Promise<void>;
    reject(error: Error): Promise<void>;
  } {
    const asked: string[] = [];
    let settlers: ((outcome: RehearsalOutcome) => void)[] = [];
    let rejecters: ((error: Error) => void)[] = [];

    return {
      asked,
      states: () => [],
      run(stateId): Promise<RehearsalOutcome> {
        asked.push(stateId);
        return new Promise<RehearsalOutcome>((resolve, reject) => {
          settlers.push(resolve);
          rejecters.push(reject);
        });
      },
      async settle(outcome = { ok: true, turnId: 'rehearsal_1', spoke: true }): Promise<void> {
        const pending = settlers;
        settlers = [];
        rejecters = [];
        for (const resolve of pending) resolve(outcome);
        // Let the surface's `.then` run before the assertion that follows it.
        await Promise.resolve();
      },
      async reject(error: Error): Promise<void> {
        const pending = rejecters;
        settlers = [];
        rejecters = [];
        for (const fail of pending) fail(error);
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  function surfaceWithRehearsal(window: FakeWindow, rehearsal: DebugRehearsalPort) {
    const hub = createDebugHub();
    return {
      hub,
      surface: createDebugSurface({
        hub,
        windows: { create: () => window },
        rehearsal,
        timers: manualTimers(),
        now: () => 1_000,
      }),
    };
  }

  it('forwards the state id and sends a frame once the turn exists', async () => {
    const window = fakeWindow();
    const rehearsal = fakeRehearsal();
    const { surface } = surfaceWithRehearsal(window, rehearsal);

    await surface.open();
    const before = frames(window).length;

    window.emitIntent({ kind: 'rehearse', stateId: 'laning-phase' });
    expect(rehearsal.asked).toEqual(['laning-phase']);

    // Not on the click: under `llm` the answer is a model call taking seconds, and there is nothing
    // to show until it lands.
    expect(frames(window).length).toBe(before);

    await rehearsal.settle();
    expect(frames(window).length).toBe(before + 1);
  });

  it('does not block the pump while a rehearsal is in flight', async () => {
    const window = fakeWindow();
    const timers = manualTimers();
    const rehearsal = fakeRehearsal();
    const surface = createDebugSurface({
      hub: createDebugHub(),
      windows: { create: () => window },
      rehearsal,
      timers,
      now: () => 1_000,
    });

    await surface.open();
    window.emitIntent({ kind: 'rehearse', stateId: 'laning-phase' });

    // The window must keep drawing while the thing it is showing progress for is running. An intent
    // handler that awaited the run would freeze the inspector for the duration of a model call.
    const before = frames(window).length;
    timers.fire();
    expect(frames(window).length).toBe(before + 1);

    await rehearsal.settle();
  });

  it('records a broken port as a problem rather than an unhandled rejection', async () => {
    const window = fakeWindow();
    const rehearsal = fakeRehearsal();
    const { hub, surface } = surfaceWithRehearsal(window, rehearsal);

    await surface.open();
    window.emitIntent({ kind: 'rehearse', stateId: 'laning-phase' });
    await rehearsal.reject(new Error('the port itself is broken'));

    // `run` is total and records its own failures, so this is only reachable if the port is broken.
    // Swallowing it would leave a button that did nothing and said nothing.
    const problems = hub.frame(1_000).problems;
    expect(problems[0]?.origin).toBe('inspector');
    expect(problems[0]?.message).toContain('the port itself is broken');
  });

  it('says so when there is no rehearsal port at all', () => {
    // A packaged build with no `fixtures/` beside it, or any shell built before ADR-0038. A button
    // that quietly does nothing is the failure this window exists to make impossible.
    const window = fakeWindow();
    const hub = createDebugHub();
    createDebugSurface({
      hub,
      windows: { create: () => window },
      timers: manualTimers(),
      now: () => 1_000,
    });

    window.emitIntent({ kind: 'rehearse', stateId: 'laning-phase' });

    expect(hub.frame(1_000).problems[0]?.message).toContain('no mock states');
  });

  it('exposes the port, so a rehearsal is drivable with no window', () => {
    const rehearsal = fakeRehearsal();
    const surface = createDebugSurface({
      hub: createDebugHub(),
      windows: { create: () => fakeWindow() },
      rehearsal,
      timers: manualTimers(),
      now: () => 1_000,
    });

    // Everything this component does has to be reachable without Electron — that is what keeps the
    // feature testable at Tier 1 and drivable from a headless replay.
    expect(surface.rehearsal).toBe(rehearsal);
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

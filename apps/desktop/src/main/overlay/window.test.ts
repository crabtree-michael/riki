import { describe, expect, it } from 'vitest';

import { createFakeClock, createFakeWindow } from '../testing/fakes.js';
import { HIDE_HOLD_MS } from '../session/timing.js';
import { createOverlayWindowController } from './window.js';
import type { OverlayWindowFactory } from './window-port.js';

function harness(platform = 'darwin') {
  const clock = createFakeClock();
  let window = createFakeWindow();
  const created: (typeof window)[] = [];

  const factory: OverlayWindowFactory = {
    create() {
      window = createFakeWindow();
      created.push(window);
      return window;
    },
  };

  const controller = createOverlayWindowController({ factory, clock, platform });
  return { controller, clock, created, current: () => created.at(-1) ?? window };
}

const BOUNDS = { x: 10, y: 10, width: 196, height: 146 };

describe('createOverlayWindowController — warm', () => {
  it('creates, loads and hides, so showFast has a surface to map', async () => {
    const { controller, current } = harness();
    await controller.warm();

    expect(current().loads).toBe(1);
    expect(controller.isVisible()).toBe(false);
  });

  it('creates the window exactly once however often it is warmed', async () => {
    const { controller, created } = harness();
    await controller.warm();
    await controller.warm();
    expect(created).toHaveLength(1);
  });

  it('honours a show that arrives before warming has finished', async () => {
    const { controller } = harness();
    controller.showFast();
    await controller.warm();
    expect(controller.isVisible()).toBe(true);
  });
});

describe('createOverlayWindowController — showing and hiding', () => {
  it('shows without taking focus', async () => {
    const { controller } = harness();
    await controller.warm();
    controller.showFast();
    expect(controller.isVisible()).toBe(true);
  });

  it('holds before hiding, so the renderer can fade out', async () => {
    const { controller, clock } = harness();
    await controller.warm();
    controller.showFast();

    controller.hide(HIDE_HOLD_MS);
    expect(controller.isVisible()).toBe(true);

    clock.advance(HIDE_HOLD_MS);
    expect(controller.isVisible()).toBe(false);
  });

  it('cancels a hide that a re-trigger overtakes — the anti-strobe rule', async () => {
    const { controller, clock } = harness();
    await controller.warm();
    controller.showFast();
    controller.hide(HIDE_HOLD_MS);

    clock.advance(HIDE_HOLD_MS / 2);
    controller.showFast();
    clock.advance(HIDE_HOLD_MS);

    expect(controller.isVisible()).toBe(true);
  });

  it('hides immediately when asked without a hold', async () => {
    const { controller } = harness();
    await controller.warm();
    controller.showFast();
    controller.hide();
    expect(controller.isVisible()).toBe(false);
  });
});

describe('createOverlayWindowController — placement', () => {
  it('applies bounds once and skips a repeat of the same ones', async () => {
    const { controller, current } = harness();
    await controller.warm();

    controller.applyPlacement(BOUNDS, 1);
    expect(current().bounds).toEqual(BOUNDS);

    current().setBounds({ x: 0, y: 0, width: 1, height: 1 });
    controller.applyPlacement({ ...BOUNDS }, 1);
    expect(current().bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('re-applies when the scale changes even though the box has not moved', async () => {
    const { controller, current } = harness();
    await controller.warm();
    controller.applyPlacement(BOUNDS, 1);
    current().setBounds({ x: 0, y: 0, width: 1, height: 1 });

    controller.applyPlacement(BOUNDS, 1.25);
    expect(current().bounds).toEqual(BOUNDS);
  });

  it('remembers placement set before the window exists', async () => {
    const { controller, current } = harness();
    controller.applyPlacement(BOUNDS, 1);
    await controller.warm();
    expect(current().bounds).toEqual(BOUNDS);
  });
});

describe('createOverlayWindowController — capture exclusion', () => {
  it('reports success where the platform has a real implementation', async () => {
    for (const platform of ['darwin', 'win32']) {
      const { controller, current } = harness(platform);
      await controller.warm();
      expect(controller.setCaptureExcluded(true)).toEqual({ requested: true, applied: true });
      expect(current().contentProtection).toBe(true);
    }
  });

  it('says plainly that it got nothing on a platform without one', async () => {
    const { controller, current } = harness('linux');
    await controller.warm();

    const result = controller.setCaptureExcluded(true);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('linux');
    expect(current().contentProtection).toBe(false);
  });

  it('re-applies the exclusion to a window created after the request', async () => {
    const { controller, current } = harness();
    controller.setCaptureExcluded(true);
    await controller.warm();
    expect(current().contentProtection).toBe(true);
  });
});

describe('createOverlayWindowController — recovery', () => {
  it('replaces the window and keeps intent subscribers across a reload', async () => {
    const { controller, created, current } = harness();
    await controller.warm();

    const seen: string[] = [];
    controller.onIntent((intent) => seen.push(intent.kind));

    await controller.reload();
    expect(created).toHaveLength(2);
    expect(created[0]?.destroyed).toBe(true);

    current().emitIntent({ kind: 'ready' });
    expect(seen).toEqual(['ready']);
  });

  it('comes back visible if it was visible when it died', async () => {
    const { controller } = harness();
    await controller.warm();
    controller.showFast();

    await controller.reload();
    expect(controller.isVisible()).toBe(true);
  });

  it('goes silent after destroy', async () => {
    const { controller, current, clock } = harness();
    await controller.warm();
    controller.showFast();
    controller.destroy();

    expect(current().destroyed).toBe(true);
    expect(controller.isVisible()).toBe(false);

    controller.showFast();
    clock.advance(10_000);
    expect(controller.isVisible()).toBe(false);
  });
});

describe('createOverlayWindowController — messages', () => {
  it('sends models and levels on their own paths', async () => {
    const { controller, current } = harness();
    await controller.warm();

    controller.send({ kind: 'teardown' });
    controller.sendLevel({ source: 'input', value: 0.3, at: 0, revision: 1 });

    expect(current().commands).toEqual([{ kind: 'teardown' }]);
    expect(current().frames).toHaveLength(1);
  });

  it('drops messages rather than throwing when there is no window yet', () => {
    const { controller } = harness();
    expect(() => {
      controller.send({ kind: 'teardown' });
    }).not.toThrow();
    expect(() => {
      controller.sendLevel({ source: 'input', value: 0, at: 0, revision: 0 });
    }).not.toThrow();
  });
});

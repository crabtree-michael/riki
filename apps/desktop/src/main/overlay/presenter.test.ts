import { describe, expect, it } from 'vitest';

import {
  createFakeClock,
  createFakeWindow,
  fakeWindowFactory,
  recordTelemetry,
} from '../testing/fakes.js';
import { machine } from '../session/machine.js';
import { DEFAULT_ENVIRONMENT } from '../session/timing.js';
import { createLevelPump } from './level-pump.js';
import { createOverlayPresenter } from './presenter.js';
import { createOverlayWindowController } from './window.js';
import type { ChipViewModel, OverlayEnvironment } from '../../shared/overlay.js';

const ENVIRONMENT: OverlayEnvironment = {
  scale: 1,
  reducedMotion: false,
  highContrast: false,
  captionsEnabled: false,
  barCount: 5,
};

function model(revision: number): ChipViewModel {
  return { ...machine.projectChip(machine.initial(DEFAULT_ENVIRONMENT, 0), 0), revision };
}

async function harness() {
  const clock = createFakeClock();
  const window = createFakeWindow();
  const telemetry = recordTelemetry();

  const controller = createOverlayWindowController({
    factory: fakeWindowFactory(window),
    clock,
    platform: 'darwin',
  });
  const pump = createLevelPump({
    now: () => clock.now(),
    send: (frame) => {
      controller.sendLevel(frame);
    },
  });
  const presenter = createOverlayPresenter({ window: controller, pump, clock, telemetry });

  await controller.warm();
  return { presenter, controller, window, clock, telemetry, pump };
}

describe('createOverlayPresenter — projection', () => {
  it('sends a model on the command channel', async () => {
    const { presenter, window } = await harness();
    presenter.project(model(3));
    expect(window.commands.at(-1)).toEqual({ kind: 'model', model: model(3) });
  });

  it('sends the environment on change, not per frame', async () => {
    const { presenter, window } = await harness();
    presenter.setEnvironment(ENVIRONMENT);
    expect(window.commands.at(-1)).toEqual({ kind: 'env', env: ENVIRONMENT });
  });
});

describe('createOverlayPresenter — a renderer that reloads', () => {
  it('re-sends the environment and the current model when the renderer announces itself', async () => {
    const { presenter, window } = await harness();
    presenter.setEnvironment(ENVIRONMENT);
    presenter.project(model(7));

    const before = window.commands.length;
    window.emitIntent({ kind: 'ready' });

    expect(window.commands.slice(before)).toEqual([
      { kind: 'env', env: ENVIRONMENT },
      { kind: 'model', model: model(7) },
    ]);
  });

  it('tells its subscribers, so the composition root can do more', async () => {
    const { presenter, window } = await harness();
    let ready = 0;
    presenter.onRendererReady(() => (ready += 1));
    window.emitIntent({ kind: 'ready' });
    expect(ready).toBe(1);
  });
});

describe('createOverlayPresenter — the 100 ms measurement', () => {
  it('measures key-down to first paint on main’s own clock', async () => {
    const { presenter, window, clock, telemetry } = await harness();
    presenter.project(model(1));

    presenter.setVisible(true);
    clock.advance(42);
    window.emitIntent({ kind: 'paint', revision: 1 });

    expect(telemetry.latencies).toEqual([42]);
  });

  it('ignores a paint for a model older than the one being shown', async () => {
    const { presenter, window, clock, telemetry } = await harness();
    presenter.project(model(5));
    presenter.setVisible(true);
    clock.advance(10);

    window.emitIntent({ kind: 'paint', revision: 4 });
    expect(telemetry.latencies).toEqual([]);
  });

  it('measures once per appearance, not once per paint', async () => {
    const { presenter, window, clock, telemetry } = await harness();
    presenter.project(model(1));
    presenter.setVisible(true);
    clock.advance(20);
    window.emitIntent({ kind: 'paint', revision: 1 });
    window.emitIntent({ kind: 'paint', revision: 1 });

    expect(telemetry.latencies).toHaveLength(1);
  });
});

describe('createOverlayPresenter — levels', () => {
  it('runs the pump only while the machine says levels are running', async () => {
    const { presenter, window, pump } = await harness();
    presenter.setVisible(true);

    presenter.pushLevel({ source: 'input', value: 0.4, at: 0, revision: 0 });
    expect(window.frames).toEqual([]);

    presenter.setLevels(true, 'input');
    expect(pump.isRunning()).toBe(true);
    presenter.pushLevel({ source: 'input', value: 0.4, at: 0, revision: 0 });
    expect(window.frames).toHaveLength(1);
  });

  it('drops every frame while the overlay is hidden', async () => {
    const { presenter, window } = await harness();
    presenter.setLevels(true, 'input');
    presenter.pushLevel({ source: 'input', value: 0.4, at: 0, revision: 0 });
    expect(window.frames).toEqual([]);
  });

  it('drops a frame belonging to a superseded model', async () => {
    const { presenter, window } = await harness();
    presenter.setVisible(true);
    presenter.setLevels(true, 'input');
    presenter.project(model(9));

    presenter.pushLevel({ source: 'input', value: 0.4, at: 0, revision: 3 });
    expect(window.frames).toEqual([]);
  });

  it('re-stamps a forwarded frame with the model it belongs to', async () => {
    const { presenter, window } = await harness();
    presenter.setVisible(true);
    presenter.setLevels(true, 'input');
    presenter.project(model(9));

    presenter.pushLevel({ source: 'input', value: 0.4, at: 0, revision: 0 });
    expect(window.frames.at(-1)?.revision).toBe(9);
  });

  it('stops the pump on dispose', async () => {
    const { presenter, pump } = await harness();
    presenter.setLevels(true, 'input');
    presenter.dispose();
    expect(pump.isRunning()).toBe(false);
  });
});

describe('createOverlayPresenter — intents', () => {
  it('forwards only the one the machine acts on', async () => {
    // One, where there were two: `confirm` went with the Confirming state (ADR-0023).
    const { presenter, window } = await harness();
    const seen: string[] = [];
    presenter.onIntent((intent) => seen.push(intent.kind));

    window.emitIntent({ kind: 'cancel' });
    window.emitIntent({ kind: 'ready' });
    window.emitIntent({ kind: 'paint', revision: 1 });
    window.emitIntent({ kind: 'fault', message: 'boom' });

    expect(seen).toEqual(['cancel']);
  });

  it('routes a renderer fault to telemetry, which is its only log path', async () => {
    const { presenter, window, telemetry } = await harness();
    void presenter;
    window.emitIntent({ kind: 'fault', message: 'boom' });
    expect(telemetry.faults).toEqual(['boom']);
  });
});

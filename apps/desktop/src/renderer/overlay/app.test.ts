import { beforeEach, describe, expect, it } from 'vitest';

import { mountOverlay } from './app.js';
import { PULSE_DURATION_MS } from './motion/director.js';
import { HIGH_CONTRAST_CLASS } from './tokens/index.js';
import { models } from './testing/models.js';
import type {
  LevelFrame,
  Millis,
  OverlayCommand,
  OverlayEnvironment,
  OverlayIntent,
  RikiOverlayBridge,
} from '../../shared/overlay.js';

const ENV: OverlayEnvironment = {
  scale: 1,
  reducedMotion: false,
  highContrast: false,
  captionsEnabled: false,
  barCount: 5,
};

/** Main's half of the bridge, and a host that only advances when a test says so. */
function harness() {
  const sent: OverlayIntent[] = [];
  const commandListeners = new Set<(command: OverlayCommand) => void>();
  const levelListeners = new Set<(frame: LevelFrame) => void>();

  const bridge: RikiOverlayBridge = {
    onCommand(fn) {
      commandListeners.add(fn);
      return () => commandListeners.delete(fn);
    },
    onLevel(fn) {
      levelListeners.add(fn);
      return () => levelListeners.delete(fn);
    },
    send: (intent) => void sent.push(intent),
  };

  let handle = 0;
  let now = 0;
  const pending = new Map<number, (t: Millis) => void>();

  const root = document.createElement('div');
  document.body.append(root);

  const app = mountOverlay(root, bridge, {
    requestFrame: (fn) => {
      handle += 1;
      pending.set(handle, fn);
      return handle;
    },
    cancelFrame: (id) => void pending.delete(id),
  });

  return {
    app,
    root,
    sent,
    command: (command: OverlayCommand) => {
      for (const fn of [...commandListeners]) fn(command);
    },
    level: (frame: LevelFrame) => {
      for (const fn of [...levelListeners]) fn(frame);
    },
    /** Runs host frames at ~60 Hz until none are pending or `count` have run. */
    run(count: number) {
      for (let i = 0; i < count; i += 1) {
        now += 16;
        const next = [...pending.entries()][0];
        if (next === undefined) return;
        pending.delete(next[0]);
        next[1](now);
      }
    },
    pendingFrames: () => pending.size,
    chip: () => root.querySelector<HTMLElement>('.riki-chip'),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('mountOverlay — announcing itself', () => {
  it('sends ready on mount, which is what makes a renderer crash recoverable', () => {
    const { sent } = harness();
    expect(sent).toEqual([{ kind: 'ready' }]);
  });
});

describe('mountOverlay — commands', () => {
  it('draws a model it is sent', () => {
    const { command, chip } = harness();
    command({ kind: 'model', model: models.listening() });
    expect(chip()?.dataset.state).toBe('listening');
  });

  it('reports the paint of each model, after the frame that drew it', () => {
    const app = harness();
    app.command({ kind: 'model', model: { ...models.listening(), revision: 7 } });

    expect(app.sent).not.toContainEqual({ kind: 'paint', revision: 7 });
    app.run(6);
    expect(app.sent).toContainEqual({ kind: 'paint', revision: 7 });
  });

  it('tears itself down when told to', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.listening() });
    app.command({ kind: 'teardown' });

    expect(app.chip()).toBeNull();
    expect(app.pendingFrames()).toBe(0);
  });
});

describe('mountOverlay — the animation clock', () => {
  it('runs while a state animates', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.listening() });
    app.run(4);
    expect(app.pendingFrames()).toBeGreaterThan(0);
  });

  it('stops on a static state rather than rendering identical frames', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.muted() });
    app.run(10);
    expect(app.pendingFrames()).toBe(0);
  });

  it('stops once an Error has finished its double-pulse', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.error() });

    app.run(4);
    expect(app.pendingFrames()).toBeGreaterThan(0);

    app.run(Math.ceil(PULSE_DURATION_MS / 16) + 8);
    expect(app.pendingFrames()).toBe(0);
  });

  it('shows the pulse even when the Error arrives mid-animation', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.listening() });
    app.run(30);

    app.command({ kind: 'model', model: models.error() });
    app.run(2);
    // Still animating: the pulse gets its own zero rather than inheriting Listening's clock.
    expect(app.pendingFrames()).toBeGreaterThan(0);
    expect(Number(app.chip()?.style.opacity)).toBeLessThan(1);
  });

  it('goes idle at rest — no window, no timer, nothing composited', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.hidden() });
    app.run(10);
    expect(app.pendingFrames()).toBe(0);
  });
});

describe('mountOverlay — levels', () => {
  it('moves the bars with the level it is fed', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.listening() });
    app.run(2);
    const quiet = firstBarScale(app.root);

    for (let at = 0; at < 400; at += 33) app.level({ source: 'input', value: 1, at, revision: 1 });
    app.run(4);

    expect(firstBarScale(app.root)).toBeGreaterThan(quiet);
  });

  it('forgets the previous turn’s level on a state change', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.speaking() });
    for (let at = 0; at < 400; at += 33) app.level({ source: 'output', value: 1, at, revision: 1 });
    app.run(4);
    const loud = firstBarScale(app.root);

    app.command({ kind: 'model', model: models.listening() });
    app.run(2);

    expect(firstBarScale(app.root)).toBeLessThan(loud);
  });
});

describe('mountOverlay — environment', () => {
  it('defaults captions off, and a streamer never discovers them live', () => {
    const app = harness();
    app.command({
      kind: 'model',
      model: { ...models.speaking(), captions: { you: 'private', riki: 'reply' } },
    });
    expect(app.root.querySelector<HTMLElement>('.riki-captions')?.hidden).toBe(true);
    expect(app.root.textContent).not.toContain('private');
  });

  it('turns them on only when told to', () => {
    const app = harness();
    app.command({ kind: 'env', env: { ...ENV, captionsEnabled: true } });
    app.command({
      kind: 'model',
      model: { ...models.speaking(), captions: { you: 'hello', riki: 'hi' } },
    });
    expect(app.root.querySelector<HTMLElement>('.riki-captions')?.hidden).toBe(false);
  });

  it('swaps a class for high contrast rather than re-rendering', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.listening() });
    const before = app.chip();

    app.command({ kind: 'env', env: { ...ENV, highContrast: true } });

    expect(app.root.classList.contains(HIGH_CONTRAST_CLASS)).toBe(true);
    expect(app.chip()).toBe(before);
  });

  it('rebuilds the bars for reduced motion, and keeps them as information', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.listening() });
    expect(app.root.querySelectorAll('.riki-bar')).toHaveLength(5);

    app.command({ kind: 'env', env: { ...ENV, reducedMotion: true } });

    expect(app.root.querySelectorAll('.riki-bar')).toHaveLength(1);
    expect(app.root.classList.contains('riki-reduced-motion')).toBe(true);
    // Static: the bar carries the level, but nothing is animating it.
    app.run(10);
    expect(app.pendingFrames()).toBe(0);
  });

  it('keeps drawing the current state through a settings change', () => {
    const app = harness();
    app.command({ kind: 'model', model: models.listening() });
    app.command({ kind: 'env', env: { ...ENV, scale: 1.5 } });
    expect(app.chip()?.dataset.state).toBe('listening');
  });
});

function firstBarScale(root: HTMLElement): number {
  const bar = root.querySelector<HTMLElement>('.riki-bar');
  const match = /scaleY\(([\d.]+)\)/.exec(bar?.style.transform ?? '');
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

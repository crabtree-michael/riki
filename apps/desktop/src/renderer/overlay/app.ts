/**
 * The overlay renderer's composition root.
 *
 * It receives a view model and a level stream, and that is all it knows. No access to Riki's
 * state, no timers of its own beyond the animation clock, and no idea what a "turn" is
 * (docs/design/overlay-architecture.md §7).
 *
 * Two things it owns that are easy to lose track of: the clock stops the moment the current
 * signature has settled, so a static state costs nothing (ui-design.md §10); and it reports the
 * first paint of each model, which is how the ≤100 ms budget is measured rather than asserted.
 */

import type {
  ChipViewModel,
  LevelFrame,
  Millis,
  MotionSignature,
  OverlayEnvironment,
  RikiOverlayBridge,
} from '../../shared/overlay.js';
import type { AnimationClock, ChipView, MotionDirector, OverlayApp } from './contracts.js';
import { createLevelBallistics } from './level/ballistics.js';
import { createAnimationClock } from './motion/clock.js';
import { createMotionDirector, settlesAtMs } from './motion/director.js';
import { HIGH_CONTRAST_CLASS } from './tokens/index.js';
import { createChipView } from './view/chip.js';

export const DEFAULT_ENVIRONMENT: OverlayEnvironment = {
  scale: 1,
  reducedMotion: false,
  highContrast: false,
  // Off by default, and it never auto-enables: a streamer must not discover on-screen transcripts
  // live (ui-design.md §9.3). Asserted by test.
  captionsEnabled: false,
  barCount: 5,
};

const REDUCED_MOTION_CLASS = 'riki-reduced-motion';

export interface OverlayAppDeps {
  readonly requestFrame: (fn: (timestamp: Millis) => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly clock?: AnimationClock;
  readonly director?: MotionDirector;
}

export function mountOverlay(
  root: HTMLElement,
  bridge: RikiOverlayBridge,
  deps?: OverlayAppDeps,
): OverlayApp {
  const view = root.ownerDocument.defaultView;
  const requestFrame =
    deps?.requestFrame ??
    ((fn: (timestamp: Millis) => void) => view?.requestAnimationFrame(fn) ?? 0);
  const cancelFrame = deps?.cancelFrame ?? ((handle: number) => view?.cancelAnimationFrame(handle));

  const clock = deps?.clock ?? createAnimationClock({ requestFrame, cancelFrame });
  const ballistics = createLevelBallistics();

  let environment = DEFAULT_ENVIRONMENT;
  let director = deps?.director ?? createMotionDirector(environment.barCount);
  let chip: ChipView = createChipView(root, environment);

  let model: ChipViewModel | null = null;
  let signature: MotionSignature = 'none';
  let level = 0;
  /** What main had measured when it sent the model; the renderer counts on from here. */
  let elapsedBaseMs = 0;
  let shownSeconds = -1;
  /** Time since the current state was entered, on the renderer's own clock. */
  let stateAgeMs: Millis = 0;
  const pendingPaints = new Set<number>();

  function applyRootClasses(): void {
    root.classList.toggle(HIGH_CONTRAST_CLASS, environment.highContrast);
    root.classList.toggle(REDUCED_MOTION_CLASS, environment.reducedMotion);
  }

  function motionPreferences() {
    return {
      reducedMotion: environment.reducedMotion,
      highContrast: environment.highContrast,
    };
  }

  function tickElapsed(tMs: Millis): void {
    if (model?.text?.elapsedMs === undefined) return;
    const seconds = Math.round((elapsedBaseMs + tMs) / 1_000);
    if (seconds === shownSeconds) return;
    shownSeconds = seconds;
    chip.tickElapsed(seconds);
  }

  /**
   * Reported after the frame that draws the model, so main's number covers a paint rather than a
   * scheduling decision. Two nested frame requests, because the first callback runs *before* the
   * paint it belongs to.
   *
   * The handles are tracked so `dispose` can cancel them: a teardown that left a frame queued
   * would leave the overlay costing something at rest, which is the one thing it must not do.
   */
  function reportPaint(revision: number): void {
    const outer = requestFrame(() => {
      pendingPaints.delete(outer);
      const inner = requestFrame(() => {
        pendingPaints.delete(inner);
        bridge.send({ kind: 'paint', revision });
      });
      pendingPaints.add(inner);
    });
    pendingPaints.add(outer);
  }

  function render(next: ChipViewModel): void {
    const changedState = model?.state !== next.state;
    model = next;

    if (changedState) {
      ballistics.reset();
      level = 0;
      stateAgeMs = 0;
      // Restart rather than leave it running: every signature animates from its own zero, and an
      // Error entered from Listening must show its double-pulse, not the settled end of it.
      clock.stop();
    }

    if (next.text?.elapsedMs === undefined) {
      elapsedBaseMs = 0;
      shownSeconds = -1;
    } else if (changedState || shownSeconds < 0) {
      elapsedBaseMs = next.text.elapsedMs;
      shownSeconds = Math.round(elapsedBaseMs / 1_000);
    }

    chip.update(next);
    reportPaint(next.revision);

    signature = director.signatureFor(next.state, motionPreferences());
    const settles = settlesAtMs(signature);

    if (settles === null || stateAgeMs < settles) {
      clock.start();
      return;
    }

    // Static: one sample, drawn correctly, with no timer running behind it (ui-design.md §10).
    clock.stop();
    chip.frame(director.sample(signature, stateAgeMs, level));
  }

  const app: OverlayApp = {
    update: render,

    level(frame: LevelFrame) {
      level = ballistics.push(frame.value, frame.at);
    },

    environment(env: OverlayEnvironment) {
      const rebuild =
        env.reducedMotion !== environment.reducedMotion ||
        env.barCount !== environment.barCount ||
        env.captionsEnabled !== environment.captionsEnabled ||
        env.scale !== environment.scale;

      environment = env;
      applyRootClasses();
      if (!rebuild) return;

      // Cheaper to rebuild twenty nodes on a settings change than to give every view an
      // environment method it would consult on every frame.
      chip.dispose();
      chip = createChipView(root, environment);
      director =
        deps?.director ??
        createMotionDirector(environment.reducedMotion ? 1 : environment.barCount);
      if (model !== null) render(model);
    },

    dispose() {
      offClock();
      offCommand();
      offLevel();
      clock.stop();
      for (const handle of pendingPaints) cancelFrame(handle);
      pendingPaints.clear();
      chip.dispose();
    },
  };

  const offClock = clock.subscribe((tMs) => {
    stateAgeMs = tMs;
    chip.frame(director.sample(signature, tMs, level));
    tickElapsed(tMs);

    const settles = settlesAtMs(signature);
    if (settles !== null && tMs >= settles) clock.stop();
  });

  const offCommand = bridge.onCommand((command) => {
    switch (command.kind) {
      case 'model':
        app.update(command.model);
        return;
      case 'env':
        app.environment(command.env);
        return;
      case 'teardown':
        app.dispose();
        return;
    }
  });

  const offLevel = bridge.onLevel((frame) => {
    app.level(frame);
  });

  applyRootClasses();
  // Main re-projects on this, which is also how the overlay recovers from a renderer crash (§10.1).
  bridge.send({ kind: 'ready' });

  return app;
}

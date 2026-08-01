/**
 * The overlay's main-process half, assembled.
 *
 * The shell calls `createOverlaySurface` once at app start, `warm()` immediately after, and then
 * hands the presenter to `createSessionRuntime` as its overlay sink. Nothing else in the app needs
 * to know that a window or a renderer exists (docs/design/overlay-architecture.md §5).
 */

import type { Clock, TelemetrySink } from '../session/contracts.js';
import type { OverlayPresenter, OverlayWindowController, PlacementResolver } from './contracts.js';
import { createLevelPump } from './level-pump.js';
import { createOverlayPresenter } from './presenter.js';
import { createPlacementResolver } from './placement.js';
import { createOverlayWindowController } from './window.js';
import type { OverlayWindowFactory } from './window-port.js';

export * from './contracts.js';
export { createLevelPump, FRAME_INTERVAL_MS } from './level-pump.js';
export { createOverlayPresenter } from './presenter.js';
export {
  BOX_HEIGHT,
  BOX_WIDTH,
  createPlacementResolver,
  resolve,
  targetDisplay,
} from './placement.js';
export { createOverlayWindowController } from './window.js';
export type { OverlayWindow, OverlayWindowFactory } from './window-port.js';

export interface OverlaySurfaceDeps {
  /** `createElectronOverlayWindowFactory` in production; a fake in tests. */
  readonly factory: OverlayWindowFactory;
  readonly clock: Clock;
  readonly telemetry: TelemetrySink;
  /** `process.platform`. Injected, because capture exclusion is the one OS-dependent behaviour. */
  readonly platform: string;
}

export interface OverlaySurface {
  readonly window: OverlayWindowController;
  readonly presenter: OverlayPresenter;
  readonly placement: PlacementResolver;
  dispose(): void;
}

export function createOverlaySurface(deps: OverlaySurfaceDeps): OverlaySurface {
  const window = createOverlayWindowController({
    factory: deps.factory,
    clock: deps.clock,
    platform: deps.platform,
  });

  const pump = createLevelPump({
    now: () => deps.clock.now(),
    send: (frame) => {
      window.sendLevel(frame);
    },
  });

  const presenter = createOverlayPresenter({
    window,
    pump,
    clock: deps.clock,
    telemetry: deps.telemetry,
  });

  return {
    window,
    presenter,
    placement: createPlacementResolver(),
    dispose() {
      presenter.dispose();
      window.destroy();
    },
  };
}

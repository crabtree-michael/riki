/**
 * `OverlayWindowController` — the Electron surface, minus Electron.
 *
 * Everything that needs a real `BrowserWindow` is behind `OverlayWindowFactory`
 * (`window-port.ts`), so the behaviour that actually carries the design — warm before show, the
 * hold before hiding, one placement per (anchor, scale, display), and reporting what capture
 * exclusion really achieved — is testable without a display
 * (docs/design/overlay-architecture.md §5.3).
 */

import type {
  LevelFrame,
  OverlayCommand,
  OverlayIntent,
  Unsubscribe,
} from '../../shared/overlay.js';
import type { Clock } from '../session/contracts.js';
import type {
  CaptureExclusionResult,
  ChipScale,
  OverlayWindowController,
  Rectangle,
} from './contracts.js';
import type { OverlayWindow, OverlayWindowFactory } from './window-port.js';

export interface OverlayWindowControllerDeps {
  readonly factory: OverlayWindowFactory;
  /** Shared with the session runtime; `hide-hold` is the one timer the machine leaves to us. */
  readonly clock: Clock;
  /** `process.platform`, injected — capture exclusion is the one behaviour that differs by OS. */
  readonly platform: string;
}

/**
 * Platforms where `setContentProtection` has a real implementation: a sharing exclusion on macOS,
 * window affinity on Windows. On anything else it is a no-op, and saying otherwise would be worse
 * than saying nothing — a streamer discovering the chip in their VOD is the failure ui-design.md
 * §9.3 exists to prevent.
 */
const CAPTURE_EXCLUSION_PLATFORMS = new Set(['darwin', 'win32']);

export function createOverlayWindowController(
  deps: OverlayWindowControllerDeps,
): OverlayWindowController {
  const { factory, clock, platform } = deps;
  const intentListeners = new Set<(intent: OverlayIntent) => void>();

  let window: OverlayWindow | null = null;
  let detachIntents: Unsubscribe | null = null;
  let placement: { readonly bounds: Rectangle; readonly scale: ChipScale } | null = null;
  let captureExcluded = false;
  /** A `showFast()` that lands before `warm()` has finished must not be lost. */
  let showWhenWarm = false;
  let destroyed = false;

  // Read through a function, not the flag: `destroy()` can land during the `await` in `warm()`,
  // and TypeScript's narrowing cannot see that, so a direct `if (destroyed)` after an await reads
  // as always-false to the type checker while being entirely reachable at runtime.
  const isDestroyed = (): boolean => destroyed;

  function attach(next: OverlayWindow): void {
    window = next;
    detachIntents = next.onIntent((intent) => {
      for (const listener of [...intentListeners]) listener(intent);
    });
    if (placement !== null) next.setBounds(placement.bounds);
    if (captureExcluded && CAPTURE_EXCLUSION_PLATFORMS.has(platform)) {
      next.setContentProtection(true);
    }
  }

  function detach(): void {
    detachIntents?.();
    detachIntents = null;
    window?.destroy();
    window = null;
  }

  return {
    /**
     * Create, load, paint once, hide. The paint-once step is what makes `showFast` a compositor
     * map rather than a cold start, and it is the part most likely to be skipped — §12 lists it as
     * a claim to verify on real hardware rather than assume from documentation.
     */
    async warm() {
      if (destroyed || window !== null) return;
      const next = factory.create();
      attach(next);
      await next.load();
      if (isDestroyed()) return;
      if (showWhenWarm) {
        showWhenWarm = false;
        next.showInactive();
      } else {
        next.hide();
      }
    },

    showFast() {
      if (destroyed) return;
      // Cancel a hide still inside its hold, so a rapid re-trigger never strobes (ui-design.md §8).
      clock.cancel('hide-hold');
      if (window === null) {
        showWhenWarm = true;
        return;
      }
      window.showInactive();
    },

    hide(afterMs) {
      showWhenWarm = false;
      if (afterMs === undefined || afterMs <= 0) {
        clock.cancel('hide-hold');
        window?.hide();
        return;
      }
      clock.schedule('hide-hold', afterMs, () => {
        window?.hide();
      });
    },

    isVisible() {
      return window?.isVisible() ?? false;
    },

    send(command: OverlayCommand) {
      window?.send(command);
    },

    sendLevel(frame: LevelFrame) {
      window?.sendLevel(frame);
    },

    applyPlacement(bounds, scale) {
      // The window changes bounds only when the anchor, the scale or the display changes. Moving
      // a transparent always-on-top window costs a compositor round trip (§3.4).
      if (placement !== null && placement.scale === scale && sameRect(placement.bounds, bounds)) {
        return;
      }
      placement = { bounds, scale };
      window?.setBounds(bounds);
    },

    setCaptureExcluded(on): CaptureExclusionResult {
      captureExcluded = on;
      if (!CAPTURE_EXCLUSION_PLATFORMS.has(platform)) {
        return {
          requested: on,
          applied: false,
          reason: `no window-level capture exclusion on ${platform}`,
        };
      }
      window?.setContentProtection(on);
      return { requested: on, applied: on };
    },

    /**
     * Crash recovery (§10.1). Nothing about the interaction is lost, because the machine is in
     * main — the renderer announces itself with `intent: ready` and the presenter re-projects.
     */
    async reload() {
      if (destroyed) return;
      const wasVisible = window?.isVisible() ?? false;
      detach();
      const next = factory.create();
      attach(next);
      await next.load();
      if (isDestroyed()) return;
      if (wasVisible) next.showInactive();
      else next.hide();
    },

    onIntent(fn) {
      intentListeners.add(fn);
      return () => intentListeners.delete(fn);
    },

    destroy() {
      destroyed = true;
      clock.cancel('hide-hold');
      intentListeners.clear();
      detach();
    },
  };
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

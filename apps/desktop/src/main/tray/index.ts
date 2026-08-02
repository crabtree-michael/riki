/**
 * The tray — ui-design.md §2.
 *
 * The tray answers *"is Riki installed, running, and permitted?"*; the overlay answers *"what is
 * Riki doing right now?"*. Keeping those two questions apart is §2's core structural call, and the
 * shape it takes in code is that this file implements `TrayEffectSink` — a one-method interface
 * that takes a `TrayGlyph` — and reads its status line from somewhere else entirely.
 *
 * `TrayEffectSink.set(glyph)` is what the interaction machine drives, four states only (§2.3). The
 * status line and the mute checkbox are *not* machine state — the health summary comes from the
 * state subsystem and mute is a condition rather than a phase (overlay §4.2) — so they arrive
 * through `setStatus` and `setMuted` instead. Three small writers beat one wide model that half
 * the app has to know how to build.
 *
 * **Mute has exactly one producer: the `toggle-mute` menu row.** Left-click is not a mute gesture.
 * On macOS a tray icon with a context menu opens that menu on left-click *and* emits `click`, so
 * wiring `click` to mute meant every attempt to read the status line silently muted Riki — and the
 * menu it opened rendered from the pre-toggle model, so the checkbox disagreed with the state.
 * ADR-0028; ui-design.md §2.3 was amended to match.
 */

import type { TrayGlyph, Unsubscribe } from '../../shared/overlay.js';
import type { TrayEffectSink } from '../session/contracts.js';
import type { CoachMode, TrayAction, TrayMenuItem, TrayModel } from './menu.js';
import { projectMenu, projectTooltip } from './menu.js';

export * from './menu.js';
export { createElectronTray } from './electron-tray.js';
export type { ElectronTrayOptions } from './electron-tray.js';

/**
 * The platform surface, behind a port for the usual reason: `Tray` cannot be constructed before
 * `app.whenReady()` and cannot be constructed at all in Vitest, and the projection above it is
 * worth testing.
 */
export interface TraySurface {
  render(glyph: TrayGlyph, tooltip: string, menu: readonly TrayMenuItem[]): void;
  onAction(listener: (action: TrayAction) => void): Unsubscribe;
  destroy(): void;
}

export interface TrayController extends TrayEffectSink {
  setStatus(status: string): void;
  setMuted(muted: boolean): void;
  /** `available: false` renders the row disabled with its reason, rather than hiding it. */
  setCoach(mode: CoachMode, available: boolean): void;
  onAction(listener: (action: TrayAction) => void): Unsubscribe;
  onToggleMute(listener: () => void): Unsubscribe;
  dispose(): void;
}

export interface TrayControllerOptions {
  /** Offers the inspector row. `config.debug.enabled`; false, and therefore absent, by default. */
  readonly debug?: boolean;
}

export function createTrayController(
  surface: TraySurface,
  options: TrayControllerOptions = {},
): TrayController {
  let model: TrayModel = {
    glyph: 'idle',
    muted: false,
    status: 'starting',
    coach: { mode: 'static', available: false },
    debug: options.debug ?? false,
  };
  let disposed = false;

  function render(): void {
    if (disposed) return;
    surface.render(model.glyph, projectTooltip(model), projectMenu(model));
  }

  const muteListeners = new Set<() => void>();
  const stopAction = surface.onAction((action) => {
    if (action !== 'toggle-mute') return;
    for (const listener of [...muteListeners]) listener();
  });

  render();

  return {
    set(glyph: TrayGlyph): void {
      if (model.glyph === glyph) return;
      model = { ...model, glyph };
      render();
    },

    setStatus(status: string): void {
      if (model.status === status) return;
      model = { ...model, status };
      render();
    },

    setMuted(muted: boolean): void {
      if (model.muted === muted) return;
      model = { ...model, muted };
      render();
    },

    setCoach(mode: CoachMode, available: boolean): void {
      if (model.coach.mode === mode && model.coach.available === available) return;
      model = { ...model, coach: { mode, available } };
      render();
    },

    /**
     * Every action *except* mute, which keeps its own subscription.
     *
     * The split survives even though `toggle-mute` now has a single producer: mute is the one
     * action with a state consequence the shell has to mirror back (`setMuted`), and routing it
     * through the generic action channel is how it would pick up a second producer again.
     */
    onAction(listener): Unsubscribe {
      return surface.onAction((action) => {
        if (action === 'toggle-mute') return;
        listener(action);
      });
    },

    onToggleMute(listener): Unsubscribe {
      muteListeners.add(listener);
      return () => muteListeners.delete(listener);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopAction();
      muteListeners.clear();
      surface.destroy();
    },
  };
}

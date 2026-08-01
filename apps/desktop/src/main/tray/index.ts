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
 */

import type { TrayGlyph, Unsubscribe } from '../../shared/overlay.js';
import type { TrayEffectSink } from '../session/contracts.js';
import type { TrayAction, TrayMenuItem, TrayModel } from './menu.js';
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
  /** Left-click → toggle mute (§2.3). Separate from `onAction` because it has no menu row. */
  onClick(listener: () => void): Unsubscribe;
  destroy(): void;
}

export interface TrayController extends TrayEffectSink {
  setStatus(status: string): void;
  setMuted(muted: boolean): void;
  onAction(listener: (action: TrayAction) => void): Unsubscribe;
  onToggleMute(listener: () => void): Unsubscribe;
  dispose(): void;
}

export function createTrayController(surface: TraySurface): TrayController {
  let model: TrayModel = { glyph: 'idle', muted: false, status: 'starting' };
  let disposed = false;

  function render(): void {
    if (disposed) return;
    surface.render(model.glyph, projectTooltip(model), projectMenu(model));
  }

  const muteListeners = new Set<() => void>();
  const stopClick = surface.onClick(() => {
    for (const listener of [...muteListeners]) listener();
  });
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

    /**
     * Every action *except* mute, which has two producers and its own subscription.
     *
     * Splitting them is what stops `quit` from being reachable by a stray left-click: the click
     * handler above is deliberately wired to one action and not to a generic dispatch.
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
      stopClick();
      stopAction();
      muteListeners.clear();
      surface.destroy();
    },
  };
}

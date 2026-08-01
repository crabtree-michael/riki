/**
 * The seam between `OverlayWindowController` and Electron.
 *
 * Everything the controller needs a real window for is listed here, and `electron-window.ts` is
 * the only file that implements it. That is what keeps the controller's own behaviour — the warm
 * path, the hold before hiding, the placement cache, what capture exclusion actually achieved — a
 * Tier 4 test with a fake window rather than a Tier 5 test with a display
 * (docs/design/overlay-architecture.md §5).
 *
 * Deliberately narrow: if a method here starts looking like `BrowserWindow`, the controller has
 * begun leaking Electron into main's logic instead of holding it at this line.
 */

import type {
  LevelFrame,
  OverlayCommand,
  OverlayIntent,
  Unsubscribe,
} from '../../shared/overlay.js';
import type { Rectangle } from './contracts.js';

export interface OverlayWindow {
  /** Loads the renderer and resolves on its first paint. */
  load(): Promise<void>;
  /** Shows without taking focus. The overlay must never steal a key press from the game. */
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  send(command: OverlayCommand): void;
  /** Levels have their own channel so a 30 Hz stream never queues behind a model (§6.1). */
  sendLevel(frame: LevelFrame): void;
  setBounds(bounds: Rectangle): void;
  /** Not portable. The controller decides what to claim; this just asks. */
  setContentProtection(on: boolean): void;
  onIntent(fn: (intent: OverlayIntent) => void): Unsubscribe;
  destroy(): void;
}

export interface OverlayWindowFactory {
  create(): OverlayWindow;
}

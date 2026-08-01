/**
 * `OverlayPresenter` — machine state to renderer, and the renderer's intents back.
 *
 * The only object in main that knows a renderer exists (docs/design/overlay-architecture.md §5.2).
 * It owns three things the runtime should not have to: the staleness rule for level frames, the
 * cached model that a reloaded renderer is re-sent, and the key-down → first-paint measurement
 * that turns the ≤100 ms budget from an assertion into a number.
 */

import type {
  ChipViewModel,
  LevelFrame,
  Millis,
  OverlayEnvironment,
  OverlayIntent,
} from '../../shared/overlay.js';
import type { Clock, TelemetrySink } from '../session/contracts.js';
import type { LevelPump, OverlayPresenter, OverlayWindowController } from './contracts.js';

export interface OverlayPresenterDeps {
  readonly window: OverlayWindowController;
  readonly pump: LevelPump;
  readonly clock: Clock;
  readonly telemetry: TelemetrySink;
}

export function createOverlayPresenter(deps: OverlayPresenterDeps): OverlayPresenter {
  const { window, pump, clock, telemetry } = deps;

  const intentListeners = new Set<(intent: OverlayIntent) => void>();
  const readyListeners = new Set<() => void>();

  let model: ChipViewModel | null = null;
  let environment: OverlayEnvironment | null = null;
  /** Stamped when the window is asked to appear; cleared by the paint that answers it. */
  let shownAt: Millis | null = null;

  const detach = window.onIntent((intent) => {
    switch (intent.kind) {
      case 'ready':
        // The renderer has just mounted, or remounted after a crash. It knows nothing, so it is
        // told everything it is allowed to know: the environment, then the current model.
        if (environment !== null) window.send({ kind: 'env', env: environment });
        if (model !== null) window.send({ kind: 'model', model });
        for (const listener of [...readyListeners]) listener();
        return;

      case 'paint':
        // Both timestamps are taken on main's clock, so there is no cross-process skew to reason
        // about. The number is pessimistic by one IPC hop, which is the safe direction (§6.1).
        if (shownAt !== null && model !== null && intent.revision >= model.revision) {
          telemetry.visibilityLatency(clock.now() - shownAt);
          shownAt = null;
        }
        return;

      case 'fault':
        // The renderer has no logger and may not import @riki/telemetry; this is its only path
        // out, which also puts its diagnostics through the same redaction rules as everything
        // else (§6.2).
        telemetry.rendererFault(intent.message);
        return;

      case 'cancel':
        for (const listener of [...intentListeners]) listener(intent);
        return;
    }
  });

  return {
    setVisible(visible, holdMs) {
      if (visible) {
        if (!window.isVisible()) shownAt = clock.now();
        window.showFast();
        return;
      }
      shownAt = null;
      window.hide(holdMs);
    },

    project(next) {
      model = next;
      window.send({ kind: 'model', model: next });
    },

    setEnvironment(env) {
      environment = env;
      window.send({ kind: 'env', env });
    },

    setLevels(running, source) {
      if (running) pump.start(source);
      else pump.stop();
    },

    pushLevel(frame: LevelFrame) {
      // Hidden costs no IPC at all, not merely no pixels (§4.5).
      if (!window.isVisible()) return;
      // A frame produced against a model the renderer has already superseded would drive the bars
      // for a state that is no longer on screen. Frames are re-stamped rather than trusted: they
      // come from the audio graph, which has never seen a model revision.
      const revision = model?.revision ?? 0;
      if (frame.revision > 0 && frame.revision < revision) return;
      pump.onFrame({ ...frame, revision });
    },

    onIntent(fn) {
      intentListeners.add(fn);
      return () => intentListeners.delete(fn);
    },

    onRendererReady(fn) {
      readyListeners.add(fn);
      return () => readyListeners.delete(fn);
    },

    dispose() {
      detach();
      intentListeners.clear();
      readyListeners.clear();
      pump.stop();
    },
  };
}

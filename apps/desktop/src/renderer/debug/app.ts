/**
 * Mounts the inspector and drives it from the bridge.
 *
 * Everything stateful about the view is here and it is three things: the last frame drawn, whether
 * drawing is frozen, and whether `not_in_match` ticks are hidden. `view.ts` is pure.
 *
 * ## Freeze is why this window is usable
 *
 * Frames arrive at 4 Hz and the interesting ones last one tick. Without a freeze, reading a gate
 * ladder means reading it while it is replaced four times a second — which is the difference
 * between a tool and a lava lamp. Freezing is renderer-side and deliberately does **not** tell main
 * to stop: the hub keeps collecting, so unfreezing shows the present rather than resuming a replay,
 * and nothing about the app's behaviour depends on a debug window's scroll position.
 *
 * ## Redrawn whole, every frame
 *
 * No diffing, no keyed reconciliation. A frame is a few kilobytes and the document is a few hundred
 * nodes; rebuilding it is well under the 250 ms between frames and it removes the entire class of
 * bug where a stale node survives because its key did not change — in a window whose only job is to
 * be believed, that class of bug is disqualifying.
 *
 * The cost is real and worth naming: text selection and scroll position inside a panel are lost on
 * every redraw. That is exactly what the freeze button is for, and it is why the scroll containers
 * are the three columns rather than the whole document.
 */

import type { DebugFrame, RikiDebugBridge } from '../../shared/debug.js';
import type { ViewOptions } from './view.js';
import {
  DEFAULT_VIEW_OPTIONS,
  el,
  renderCounters,
  renderDerived,
  renderEnemies,
  renderGates,
  renderHeader,
  renderProblems,
  renderTicks,
  renderTurns,
  renderWorld,
} from './view.js';

export interface InspectorHandle {
  /** Applies a frame as if it had arrived on the bridge. The seam every test drives. */
  apply(frame: DebugFrame): void;
  readonly frozen: boolean;
  setFrozen(frozen: boolean): void;
  dispose(): void;
}

export function mountInspector(root: HTMLElement, bridge: RikiDebugBridge): InspectorHandle {
  let latest: DebugFrame | null = null;
  let frozen = false;
  let options: ViewOptions = DEFAULT_VIEW_OPTIONS;
  let torndown = false;

  function draw(): void {
    root.textContent = '';

    if (torndown) {
      root.append(el('div', 'ins-offline', 'The app is shutting down.'));
      return;
    }
    if (latest === null) {
      root.append(el('div', 'ins-offline', 'Waiting for the first frame…'));
      return;
    }

    const frame = latest;
    root.append(withControls(renderHeader(frame)));

    const body = el('div', 'ins-body');

    const state = el('div', 'ins-column');
    state.append(
      renderGates(frame.session.gates, frame.at),
      renderWorld(frame.world),
      renderEnemies(frame.world),
      renderDerived(frame.world),
    );

    const triggers = el('div', 'ins-column');
    triggers.append(renderTicks(frame, options));

    const coach = el('div', 'ins-column');
    coach.append(
      renderTurns(frame),
      renderCounters(frame),
      renderProblems(frame.problems, frame.at),
    );

    body.append(state, triggers, coach);
    root.append(body);
  }

  function withControls(header: HTMLElement): HTMLElement {
    header.append(el('span', 'ins-spacer'));

    const filter = el('button', 'ins-button', 'Hide not_in_match');
    filter.setAttribute('type', 'button');
    filter.setAttribute('aria-pressed', String(options.hideNotInMatch));
    filter.addEventListener('click', () => {
      options = { ...options, hideNotInMatch: !options.hideNotInMatch };
      draw();
    });

    const freeze = el('button', 'ins-button', frozen ? 'Frozen' : 'Freeze');
    freeze.setAttribute('type', 'button');
    freeze.setAttribute('aria-pressed', String(frozen));
    freeze.addEventListener('click', () => {
      frozen = !frozen;
      draw();
    });

    header.append(filter, freeze);
    return header;
  }

  const stop = bridge.onCommand((command) => {
    if (command.kind === 'teardown') {
      torndown = true;
      draw();
      return;
    }
    apply(command.frame);
  });

  function apply(frame: DebugFrame): void {
    // Out-of-order delivery should not be possible over one IPC channel, but a frame older than the
    // one on screen would present as the state going backwards — which is the single most
    // misleading thing a debug window can do.
    if (latest !== null && frame.revision <= latest.revision) return;
    latest = frame;
    if (!frozen) draw();
  }

  draw();
  // The frame the pump would otherwise make us wait 250 ms for, and the announcement that lets main
  // re-push after this renderer crashes and remounts.
  bridge.send({ kind: 'ready' });

  return {
    apply,

    get frozen() {
      return frozen;
    },

    setFrozen(next: boolean): void {
      frozen = next;
      draw();
    },

    dispose(): void {
      stop();
      root.textContent = '';
    },
  };
}

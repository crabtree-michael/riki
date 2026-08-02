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
 * ## Redrawn whole, every frame — but not rebuilt whole
 *
 * No diffing, no keyed reconciliation. A frame is a few kilobytes and the document is a few hundred
 * nodes; rebuilding it is well under the 250 ms between frames and it removes the entire class of
 * bug where a stale node survives because its key did not change — in a window whose only job is to
 * be believed, that class of bug is disqualifying.
 *
 * Three nodes are exempt, and the exemption is what makes the window readable while a match is
 * running: the **three `.ins-column` scroll containers persist**, and each redraw replaces only
 * their children. `scrollTop` belongs to the element, so a column rebuilt from scratch arrives at
 * the top with no position to restore — which is what used to yank a reader back to the newest tick
 * four times a second. `scroll.ts` does the rest: it notes what was under the reader's eye before
 * the swap and puts it back at the same height afterwards. See its header for the anchoring rules.
 *
 * The header's two buttons persist for the same kind of reason. They are the only focusable things
 * on the screen, and a button destroyed mid-frame takes keyboard focus to `<body>` with it.
 *
 * Text selection is still lost on every redraw, and that is what the freeze button is for.
 */

import type { DebugFrame, RikiDebugBridge } from '../../shared/debug.js';
import type { ViewOptions } from './view.js';
import { captureScroll, restoreScroll } from './scroll.js';
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

  // Built once and never replaced. `spacer` doubles as the boundary between the part of the header
  // that is redrawn from the frame and the part that is not.
  const header = el('header', 'ins-header');
  const spacer = el('span', 'ins-spacer');
  const filter = el('button', 'ins-button', 'Hide not_in_match');
  const freeze = el('button', 'ins-button', 'Freeze');
  const stateColumn = el('div', 'ins-column');
  const triggerColumn = el('div', 'ins-column');
  const coachColumn = el('div', 'ins-column');
  const body = el('div', 'ins-body');

  filter.setAttribute('type', 'button');
  filter.addEventListener('click', () => {
    options = { ...options, hideNotInMatch: !options.hideNotInMatch };
    draw();
  });

  freeze.setAttribute('type', 'button');
  freeze.addEventListener('click', () => {
    frozen = !frozen;
    draw();
  });

  header.append(spacer, filter, freeze);
  body.append(stateColumn, triggerColumn, coachColumn);

  /** Whether `header` and `body` are in the document, as opposed to an offline message. */
  let attached = false;

  function draw(): void {
    if (torndown) {
      offline('The app is shutting down.');
      return;
    }
    if (latest === null) {
      offline('Waiting for the first frame…');
      return;
    }

    const frame = latest;
    drawHeader(frame);

    fill(stateColumn, [
      renderGates(frame.session.gates, frame.at),
      renderWorld(frame.world),
      renderEnemies(frame.world),
      renderDerived(frame.world),
    ]);
    fill(triggerColumn, [renderTicks(frame, options)]);
    fill(coachColumn, [
      renderTurns(frame),
      renderCounters(frame),
      renderProblems(frame.problems, frame.at),
    ]);

    if (!attached) {
      root.replaceChildren(header, body);
      attached = true;
    }
  }

  function offline(message: string): void {
    root.replaceChildren(el('div', 'ins-offline', message));
    // The columns are out of the document now, so whatever they were scrolled to is gone. Both
    // messages are terminal enough that restoring it on the way back would be a lie anyway.
    attached = false;
  }

  /** Replaces a column's contents without letting go of where the reader was looking. */
  function fill(column: HTMLElement, panels: readonly HTMLElement[]): void {
    const position = captureScroll(column);
    column.replaceChildren(...panels);
    restoreScroll(column, position);
  }

  function drawHeader(frame: DebugFrame): void {
    // Everything before the spacer came from the last frame; the spacer and the buttons after it
    // stay put, which is what keeps focus and the pressed state off the redraw path.
    while (header.firstChild !== null && header.firstChild !== spacer) {
      header.removeChild(header.firstChild);
    }
    // `Array.from` rather than spreading the NodeList: the renderer's `lib` is `DOM` without
    // `DOM.Iterable`. It also snapshots, which matters — `childNodes` is live and `append` empties
    // the header `renderHeader` just built.
    const fresh = document.createDocumentFragment();
    fresh.append(...Array.from(renderHeader(frame).childNodes));
    header.insertBefore(fresh, spacer);

    filter.setAttribute('aria-pressed', String(options.hideNotInMatch));
    freeze.setAttribute('aria-pressed', String(frozen));
    freeze.textContent = frozen ? 'Frozen' : 'Freeze';
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
      root.replaceChildren();
      attached = false;
    },
  };
}

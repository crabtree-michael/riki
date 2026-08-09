/**
 * Mounts the inspector and drives it from the bridge.
 *
 * Everything stateful about the view is here and it is two things: the last frame drawn, and
 * whether drawing is frozen. `view.ts` is pure.
 *
 * ## One listener, not four hundred
 *
 * The Actions panel (ADR-0039) is the only interactive surface inside a column, and a column's
 * children are replaced four times a second. Per-node listeners would be created and discarded at
 * that rate for the life of the window, so `view.ts` marks its buttons with `data-action` and this
 * file puts a single delegated `click` on the root.
 *
 * ## Focus has to be restored by hand
 *
 * The header's button persists and keeps its own focus. A button inside a column does not: a redraw
 * replaces the node the user is standing on and takes keyboard focus to `<body>` with it, which
 * makes tabbing to a scenario impossible. Every actionable node carries a stable `data-focus` key
 * and `draw()` puts focus back on the node that has it. It is the focus counterpart of what
 * `scroll.ts` does for position, and it is eight lines.
 *
 * The restore is `focus({ preventScroll: true })`, because the two halves run in the same frame and
 * the default would have the second undo the first: `focus()` scrolls its element into view inside
 * the very column `scroll.ts` has just put back.
 *
 * ## Freeze is why this window is usable
 *
 * Frames arrive at 4 Hz and the interesting ones last one frame. Without a freeze, reading a turn's
 * snapshot means reading it while it is replaced four times a second — which is the difference
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
 * Two nodes are exempt, and the exemption is what makes the window readable while a match is
 * running: the **two `.ins-column` scroll containers persist**, and each redraw replaces only
 * their children. `scrollTop` belongs to the element, so a column rebuilt from scratch arrives at
 * the top with no position to restore — which is what used to yank a reader back to the newest row
 * four times a second. `scroll.ts` does the rest: it notes what was under the reader's eye before
 * the swap and puts it back at the same height afterwards. See its header for the anchoring rules.
 *
 * The header's button persists for the same kind of reason. It is the only focusable thing that
 * always exists, and a button destroyed mid-frame takes keyboard focus to `<body>` with it.
 *
 * Text selection is still lost on every redraw, and that is what the freeze button is for.
 */

import type { DebugFrame, RikiDebugBridge } from '../../shared/debug.js';
import { captureScroll, restoreScroll } from './scroll.js';
import {
  el,
  renderActions,
  renderDerived,
  renderEnemies,
  renderHeader,
  renderProblems,
  renderSources,
  renderTrace,
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
  let torndown = false;

  // Built once and never replaced. `spacer` doubles as the boundary between the part of the header
  // that is redrawn from the frame and the part that is not.
  const header = el('header', 'ins-header');
  const spacer = el('span', 'ins-spacer');
  const freeze = el('button', 'ins-button', 'Freeze');
  const stateColumn = el('div', 'ins-column');
  const turnColumn = el('div', 'ins-column');
  const body = el('div', 'ins-body');

  freeze.setAttribute('type', 'button');
  freeze.addEventListener('click', () => {
    frozen = !frozen;
    draw();
  });

  header.append(spacer, freeze);
  body.append(stateColumn, turnColumn);

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

    // Read before the columns are refilled and restored at the end, for the same reason `scroll.ts`
    // captures a position: the node the reader is standing on is about to be replaced. Keyed off
    // `document.activeElement`, so focus that was outside this widget reads as null and is not
    // stolen.
    const focused = document.activeElement;
    const focusKey =
      focused instanceof HTMLElement && root.contains(focused)
        ? (focused.dataset.focus ?? null)
        : null;

    const frame = latest;
    drawHeader(frame);

    fill(stateColumn, [
      // First, above everything: the one panel that *acts*, and what it produces lands in the
      // column beside it and in the Trace — so the reading order is the causal one (ADR-0039).
      renderActions(frame.actions),
      renderWorld(frame.world),
      renderEnemies(frame.world),
      renderDerived(frame.world),
    ]);
    fill(turnColumn, [
      renderTurns(frame),
      renderTrace(frame.trace, frame.at),
      renderSources(frame),
      renderProblems(frame.problems, frame.at),
    ]);

    if (!attached) {
      root.replaceChildren(header, body);
      attached = true;
    }

    if (focusKey !== null) {
      const restored = root.querySelector(`[data-focus="${cssEscape(focusKey)}"]`);
      // `preventScroll`, and it is load-bearing rather than tidy: `focus()` also scrolls the element
      // into view inside its scrolling ancestor, which is the column `scroll.ts` has just finished
      // restoring. Without it, touching a control and then scrolling down to read what it did to the
      // gates or the world model is impossible — the control still holds focus, it sits in the first
      // panel, and every frame scrolls it back into view. That is the same complaint ADR-0036 fixed,
      // arriving by a different route: this half runs after the restore and overrides it.
      if (restored instanceof HTMLElement) restored.focus({ preventScroll: true });
    }
  }

  /**
   * `CSS.escape`, or a good-enough fall-back.
   *
   * The keys are ours — an action id — so the characters in them are known and tame. This is here because `happy-dom` does not implement `CSS.escape`, and a Tier 1
   * test that threw on the first redraw after a click would be a test failure with no defect
   * behind it.
   */
  function cssEscape(value: string): string {
    return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : value.replace(/["\\]/g, '\\$&');
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

    freeze.setAttribute('aria-pressed', String(frozen));
    freeze.textContent = frozen ? 'Frozen' : 'Freeze';
  }

  /**
   * The whole event surface: one listener, on the root, for the window's life.
   *
   * Nothing here changes local state. Everything is sent and then *forgotten* — the panel redraws
   * from the next frame, so a scenario that main refused appears as what main decided rather than
   * as what was clicked. That is the same rule the overlay follows: the renderer draws what it is
   * told and never predicts.
   */
  function onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('button');
    if (button === null || button.hasAttribute('disabled')) return;

    if (button.dataset.clearTrace !== undefined) {
      bridge.send({ kind: 'clear-trace' });
      return;
    }

    const action = button.dataset.action;
    if (action !== undefined) {
      // Sent and forgotten: the row turns to `running` because the *next* frame says so, not
      // because this handler assumed it would.
      bridge.send({ kind: 'action', id: action });
    }
  }

  root.addEventListener('click', onClick);

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
      root.removeEventListener('click', onClick);
      root.replaceChildren();
      attached = false;
    },
  };
}

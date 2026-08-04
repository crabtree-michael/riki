/**
 * Mounts the inspector and drives it from the bridge.
 *
 * Everything stateful about the view is here and it is six things: the last frame drawn, whether
 * drawing is frozen, whether `not_in_match` ticks are hidden, which Controls groups are expanded,
 * which mock game state is selected, and whether that dropdown is open. `view.ts` is pure.
 *
 * The last two are view state for the same reason the others are, and for one more: the selection
 * is *null until somebody picks*, because the mock library is re-read off disk four times a second
 * and a default captured at mount would be a guess that goes stale. `renderRehearsal` resolves null
 * against the list in the frame it is drawing, and the Rehearse button carries the id it resolved
 * to — so what is sent is always what the button said it would send.
 *
 * ## One listener, not four hundred
 *
 * The Controls panel (ADR-0037) and the Rehearsal panel (ADR-0038) are the only interactive
 * surfaces inside a column, and a column's children are replaced four times a second. Per-node listeners would be created and discarded at
 * that rate for the life of the window, so `view.ts` marks its buttons with `data-control` and this
 * file puts a single delegated `click` on the root. The value crosses as a string and is decoded
 * here against `data-kind`, which is the same shape as every other boundary in this app: the sender
 * describes, the receiver decides.
 *
 * ## Focus has to be restored by hand
 *
 * The header's two buttons persist and keep their own focus. Everything in the Controls panel does
 * not: its buttons live inside a column, so a redraw replaces the node the user is standing on and
 * takes keyboard focus to `<body>` with it — which makes holding `+` down, or tabbing to a control
 * at all, impossible. Every actionable node carries a stable `data-focus` key and `draw()` puts
 * focus back on the node that has it. It is the focus counterpart of what `scroll.ts` does for
 * position, and it is eight lines.
 *
 * The restore is `focus({ preventScroll: true })`, because the two halves run in the same frame and
 * the default would have the second undo the first: `focus()` scrolls its element into view inside
 * the very column `scroll.ts` has just put back. A focused control is in the topmost panel, so the
 * effect was a reader who moved one setting and then could not scroll down to watch it work.
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

import type { DebugControlValue, DebugFrame, RikiDebugBridge } from '../../shared/debug.js';
import type { ViewOptions } from './view.js';
import { captureScroll, restoreScroll } from './scroll.js';
import {
  DEFAULT_VIEW_OPTIONS,
  el,
  renderActions,
  renderControls,
  renderCounters,
  renderDerived,
  renderEnemies,
  renderGates,
  renderHeader,
  renderProblems,
  renderRehearsal,
  renderTrace,
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
      // First, above everything: the two panels that *act*, and what they produce lands
      // two columns over and in the Trace. Below them, Controls — a rehearsal and a
      // scenario both run against whatever that panel currently says, so the reading order
      // is the causal one (ADR-0038 and ADR-0039, then ADR-0037).
      renderRehearsal(frame.mocks, options),
      renderActions(frame.actions),
      renderControls(frame.controls, options),
      renderGates(frame.session.gates, frame.at),
      renderWorld(frame.world),
      renderEnemies(frame.world),
      renderDerived(frame.world),
    ]);
    fill(triggerColumn, [renderTicks(frame, options)]);
    fill(coachColumn, [
      renderTurns(frame),
      renderCounters(frame),
      renderTrace(frame.trace, frame.at),
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
   * The keys are ours — a control id, a group name, an enum option — so the characters in them are
   * known and tame. This is here because `happy-dom` does not implement `CSS.escape`, and a Tier 1
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

    filter.setAttribute('aria-pressed', String(options.hideNotInMatch));
    freeze.setAttribute('aria-pressed', String(frozen));
    freeze.textContent = frozen ? 'Frozen' : 'Freeze';
  }

  /**
   * A control's value crosses the DOM as a string; this turns it back.
   *
   * Refusing rather than guessing when `kind` is missing or the number will not parse. The other
   * side of this wire is `parseDebugIntent`, which refuses the same things again — but a `NaN` that
   * left here would be a stepper that silently stopped working, which is harder to notice than one
   * that never sent.
   */
  function decodeControl(
    kind: string | undefined,
    raw: string | undefined,
  ): DebugControlValue | null {
    if (raw === undefined) return null;
    if (kind === 'boolean') return raw === 'true';
    if (kind === 'enum') return raw;
    if (kind !== 'number') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function toggleGroup(name: string): readonly string[] {
    return options.openGroups.includes(name)
      ? options.openGroups.filter((each) => each !== name)
      : [...options.openGroups, name];
  }

  /**
   * The Controls panel's whole event surface: one listener, on the root, for the window's life.
   *
   * Nothing here changes local state except the group expansion, which is view state and never
   * leaves the renderer. Everything else is sent and then *forgotten* — the panel redraws from the
   * next frame, so a value that main clamped, snapped or refused appears as what main decided rather
   * than as what was clicked. That is the same rule the overlay follows: the renderer draws what it
   * is told and never predicts.
   */
  function onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('button');
    if (button === null || button.hasAttribute('disabled')) return;

    const group = button.dataset.group;
    if (group !== undefined) {
      options = { ...options, openGroups: toggleGroup(group) };
      draw();
      return;
    }

    // The three the Rehearsal panel adds (ADR-0038). The first two are view state and never leave
    // the renderer; only the third sends, and it sends the id the button was drawn with rather than
    // `options.selectedMock` — which is null until somebody picks, while the button has been
    // showing the library's first state all along.
    if (button.dataset.mockToggle !== undefined) {
      options = { ...options, mockOpen: !options.mockOpen };
      draw();
      return;
    }

    const mock = button.dataset.mock;
    if (mock !== undefined) {
      // Closed on choice, which is what a dropdown does and what keeps the panel short between uses.
      options = { ...options, selectedMock: mock, mockOpen: false };
      draw();
      return;
    }

    const rehearse = button.dataset.rehearse;
    if (rehearse !== undefined) {
      bridge.send({ kind: 'rehearse', stateId: rehearse });
      return;
    }

    if (button.dataset.reset !== undefined) {
      bridge.send({ kind: 'reset-controls' });
      return;
    }

    if (button.dataset.clearTrace !== undefined) {
      bridge.send({ kind: 'clear-trace' });
      return;
    }

    const action = button.dataset.action;
    if (action !== undefined) {
      // Sent and forgotten, exactly as a control is: the row turns to `running` because the *next*
      // frame says so, not because this handler assumed it would.
      bridge.send({ kind: 'action', id: action });
      return;
    }

    const id = button.dataset.control;
    if (id === undefined) return;
    const value = decodeControl(button.dataset.kind, button.dataset.value);
    if (value === null) return;
    bridge.send({ kind: 'control', id, value });
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

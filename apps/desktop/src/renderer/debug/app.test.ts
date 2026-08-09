/**
 * The inspector's view, in an in-memory document.
 *
 * Tier 1 by REPO_SKELETON.md §5.2's rule — no game, no microphone, no GPU, no window — which is why
 * `desktop-renderer` is a Vitest project at all. Tier 5 is still the only place a real window
 * launches, and there is no harness for it yet.
 *
 * What is asserted is what somebody would be misled by if it were wrong: that a turn's cause is
 * distinguishable from a scenario's, that a null reads as a null, that the reader is not dragged
 * back to the top four times a second, and that nothing on the screen came from `innerHTML`.
 *
 * This file used to be twice this length, and most of what went with ADR-0042 was the gate ladder:
 * thirteen verdicts per candidate, the `not_in_match` filter, the Controls panel's steppers and
 * locks, and the Rehearsal dropdown. None of it had a subject any more. The tool trace (ADR-0047)
 * is what took its place, and `describe('tool calls')` below is where its two claims are checked:
 * that a replayed turn renders every call it made, and that a turn which made none looks different.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  DebugCommand,
  DebugFrame,
  DebugIntent,
  DebugToolCall,
  DebugTurn,
  RikiDebugBridge,
} from '../../shared/debug.js';
import { mountInspector } from './app.js';
import { formatClock } from './view.js';

// -------------------------------------------------------------------------------------------

function frame(overrides: Partial<DebugFrame> = {}): DebugFrame {
  return {
    revision: 1,
    at: 10_000,
    session: {
      matchId: '789',
      matchSession: true,
      chipPhase: 'idle',
      chipVisible: false,
      muted: false,
      health: {
        level: 'gsi_only',
        summary: 'GSI only',
        sources: [],
        bus: { depth: 0, dropped: [], gaps: [] },
      },
    },
    world: {
      version: 12,
      clock: 620,
      paused: false,
      versionsPerSecond: 4.2,
      facts: [
        {
          path: 'self.gold',
          value: '{"reliable":100,"unreliable":900}',
          source: 'gsi',
          confidence: 1,
          staleness: 'fresh',
          ageMs: 120,
          ageBasis: 'game',
        },
      ],
      enemies: [],
      derived: [],
    },
    turns: [],
    problems: [],
    actions: [],
    trace: [],
    ...overrides,
  };
}

/**
 * One turn, defaulted to a player question that called one tool.
 *
 * Grounded by default rather than bare, so that the no-tool-call mark is something a test asks for
 * explicitly. The alternative — every fixture flagged, and the flag asserted by opting *out* — is
 * how a mark that fires on everything passes its own tests.
 */
function turn(overrides: Partial<DebugTurn> = {}): DebugTurn {
  return {
    turnId: 'voice_1',
    at: 9_000,
    clock: 600,
    cause: 'player',
    snapshotText: 'clock 10:00',
    snapshotTokens: 42,
    snapshotOmitted: [],
    outcome: 'spoke',
    closedAt: 11_000,
    tools: [call()],
    toolsDropped: 0,
    agentSaid: null,
    playerSaidChars: null,
    ...overrides,
  };
}

/** One tool call, defaulted to one that answered. */
function call(overrides: Partial<DebugToolCall> = {}): DebugToolCall {
  return {
    seq: 1,
    at: 9_400,
    name: 'my_state',
    args: '{}',
    status: 'ok',
    result: '{"level":{"value":9,"age_seconds":0.2,"confidence":1,"source":"gsi"}}',
    durationMs: 12,
    ...overrides,
  };
}

/** One trace step, defaulted to something outside a run. */
function step(overrides: Partial<DebugFrame['trace'][number]> = {}): DebugFrame['trace'][number] {
  return {
    at: 9_500,
    seq: 1,
    stage: 'turn',
    message: 'push-to-talk voice_1 (push)',
    sinceRunMs: null,
    ...overrides,
  };
}

const ACTION: DebugFrame['actions'][number] = {
  id: 'scenario.speak',
  group: 'Scenarios',
  label: 'Speak now',
  note: 'sends one turn straight to the session port',
  running: false,
  lastOutcome: null,
};

interface FakeBridge extends RikiDebugBridge {
  readonly sent: DebugIntent[];
  /** Drives main's half of the bridge. */
  emit(command: DebugCommand): void;
}

function fakeBridge(): FakeBridge {
  const sent: DebugIntent[] = [];
  const listeners = new Set<(command: DebugCommand) => void>();
  return {
    sent,
    onCommand(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    send: (intent) => void sent.push(intent),
    emit(command) {
      for (const listener of [...listeners]) listener(command);
    },
  };
}

/** Crude geometry for the focus model below, in the same spirit as `scroll.test.ts`'s. */
const ROW_PX = 100;
const VIEWPORT_PX = 300;

/**
 * Models the half of `HTMLElement.focus()` that `happy-dom` leaves out: Chromium also scrolls the
 * focused element into view, inside its nearest scrollable ancestor — here, a `.ins-column`.
 *
 * `happy-dom` moves `document.activeElement` and stops, so a redraw that yanks the column back to a
 * focused button is invisible to every other test in this file. The modelled position is the
 * element's place among the column's focusable nodes at `ROW_PX` each, which is crude in the way
 * `scroll.test.ts`'s row heights are crude and for the same reason: the arithmetic is not the point,
 * the movement is. `preventScroll` is honoured, because that is what the fix turns on.
 *
 * Returns the undo, which the caller owes the rest of the suite — this patches a prototype.
 */
function modelFocusScrolling(): () => void {
  // Off the descriptor rather than off `HTMLElement.prototype.focus`, which is a method reference
  // separated from its object and rightly refused by `@typescript-eslint/unbound-method`. It is
  // called with an explicit receiver below, which is the thing that rule exists to make you prove.
  const own: unknown = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')?.value;
  if (typeof own !== 'function') throw new Error('no HTMLElement.prototype.focus to model');
  const native = own as (this: HTMLElement, options?: FocusOptions) => void;

  HTMLElement.prototype.focus = function patched(this: HTMLElement, options?: FocusOptions): void {
    native.call(this, options);
    if (options?.preventScroll === true) return;

    const column = this.closest('.ins-column');
    if (!(column instanceof HTMLElement)) return;
    const focusable = Array.from(column.querySelectorAll<HTMLElement>('[data-focus]'));
    const index = focusable.indexOf(this);
    if (index === -1) return;

    const top = index * ROW_PX;
    if (top < column.scrollTop) column.scrollTop = top;
    else if (top + ROW_PX > column.scrollTop + VIEWPORT_PX) {
      column.scrollTop = top + ROW_PX - VIEWPORT_PX;
    }
  };
  return () => {
    HTMLElement.prototype.focus = native;
  };
}

let root: HTMLElement;

beforeEach(() => {
  document.body.textContent = '';
  root = document.createElement('div');
  document.body.append(root);
});

// -------------------------------------------------------------------------------------------

describe('mounting', () => {
  it('says it is waiting rather than rendering an empty shell', () => {
    mountInspector(root, fakeBridge());
    expect(root.textContent).toContain('Waiting for the first frame');
  });

  it('announces itself, so main pushes a frame without waiting out the interval', () => {
    const bridge = fakeBridge();
    mountInspector(root, bridge);
    expect(bridge.sent).toEqual([{ kind: 'ready' }]);
  });

  it('draws a frame that arrives on the bridge', () => {
    const bridge = fakeBridge();
    mountInspector(root, bridge);
    bridge.emit({ kind: 'frame', frame: frame({ turns: [turn()] }) });
    expect(root.textContent).toContain('voice_1');
  });

  it('says so when the app is shutting down', () => {
    const bridge = fakeBridge();
    mountInspector(root, bridge);
    bridge.emit({ kind: 'teardown' });
    expect(root.textContent).toContain('shutting down');
  });
});

describe('freeze', () => {
  it('holds the drawn frame while still accepting new ones', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn()] }));

    view.setFrozen(true);
    view.apply(frame({ revision: 2, turns: [turn({ turnId: 'voice_2' })] }));
    expect(root.textContent).toContain('voice_1');
    expect(root.textContent).not.toContain('voice_2');

    // Unfreezing shows the present, not a resumed replay — main never stopped collecting.
    view.setFrozen(false);
    view.apply(frame({ revision: 3, turns: [turn({ turnId: 'voice_2' })] }));
    expect(root.textContent).toContain('voice_2');
  });

  it('drops a frame older than the one on screen', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ revision: 5, turns: [turn()] }));
    view.apply(frame({ revision: 4, turns: [turn({ turnId: 'voice_2' })] }));
    // State appearing to go backwards is the single most misleading thing a debug window can do.
    expect(root.textContent).toContain('voice_1');
  });
});

describe('live updates and the reader', () => {
  const columns = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('.ins-column'));

  it('keeps the same scroll containers across a redraw', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn()] }));
    const before = columns();

    view.apply(frame({ revision: 2, turns: [turn({ turnId: 'voice_2' })] }));

    // `scrollTop` belongs to the element. A column rebuilt from scratch arrives at the top with no
    // position to restore, and no amount of restoring afterwards can invent one.
    expect(columns()).toHaveLength(2);
    expect(columns()[0]).toBe(before[0]);
    expect(columns()[1]).toBe(before[1]);
    // The contents are still redrawn whole, which is the part worth keeping.
    expect(root.textContent).toContain('voice_2');
    expect(root.textContent).not.toContain('voice_1');
  });

  it('does not send the reader back to the top when a frame arrives', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn()] }));

    const turnColumn = columns()[1];
    expect(turnColumn).toBeDefined();
    if (turnColumn === undefined) return;
    turnColumn.scrollTop = 240;

    view.apply(frame({ revision: 2, turns: [turn({ turnId: 'voice_2' })] }));

    // The whole complaint, in one assertion: reading anything older than the newest row was
    // impossible while the match was running, because 4 Hz of frames each rebuilt the column.
    expect(turnColumn.scrollTop).toBe(240);
  });

  it('does not take keyboard focus off the header button mid-frame', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame());

    const freeze = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((each) =>
      each.textContent.includes('Freeze'),
    );
    expect(freeze).toBeDefined();
    freeze?.focus();

    view.apply(frame({ revision: 2 }));

    // It is the only focusable thing that always exists, so a redraw that replaced it would drop
    // focus to `<body>` four times a second.
    expect(document.activeElement).toBe(freeze);
    expect(freeze?.getAttribute('aria-pressed')).toBe('false');
  });

  it('puts focus back on a scenario button after a redraw', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ actions: [ACTION] }));

    const find = (): HTMLElement | null =>
      root.querySelector<HTMLElement>('[data-focus="action:scenario.speak"]');
    find()?.focus();

    view.apply(frame({ revision: 2, actions: [ACTION] }));

    // Without this, tabbing to a scenario at all is impossible: the button lives inside a column,
    // and the column's children are replaced four times a second.
    expect(document.activeElement).toBe(find());
  });

  it('does not drag the column back to the focused button on every frame', () => {
    const restore = modelFocusScrolling();
    try {
      const view = mountInspector(root, fakeBridge());
      view.apply(frame({ actions: [ACTION] }));

      const state = root.querySelector<HTMLElement>('.ins-column');
      expect(state).not.toBeNull();
      if (state === null) return;

      root.querySelector<HTMLElement>('[data-focus="action:scenario.speak"]')?.focus();
      state.scrollTop = 600;

      view.apply(frame({ revision: 2, actions: [ACTION] }));

      // `scroll.ts` puts the reader back and then focus restoration takes them away again: the
      // button that still holds focus is in the first panel, so scrolling it into view is scrolling
      // to the top. At 4 Hz the column cannot be scrolled away from it at all.
      expect(state.scrollTop).toBe(600);
    } finally {
      restore();
    }
  });

  it('still redraws the header from the frame', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame());
    expect(root.textContent).toContain('789');

    view.apply(frame({ revision: 2, session: { ...frame().session, matchId: '790' } }));
    expect(root.textContent).toContain('790');
    expect(root.textContent).not.toContain('789');
  });

  it('gives every repeated row an identity that outlives the redraw', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn()], trace: [step()] }));

    // Namespaced by panel, so `row:bus depth` in Sources cannot be mistaken for a same-named row
    // elsewhere in the column when `scroll.ts` goes looking for it.
    expect(root.querySelector('.ins-turn')?.getAttribute('data-ins-key')).toBe(
      'Turns/turn:voice_1',
    );

    const keys = Array.from(root.querySelectorAll('[data-ins-key]'), (node) =>
      node.getAttribute('data-ins-key'),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('turns', () => {
  it('shows the snapshot as rendered, and what Riki said', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({
            snapshotText: 'clock 10:00\nself lvl 9',
            snapshotOmitted: ['map'],
            agentSaid: 'Your ult is up.',
          }),
        ],
      }),
    );

    expect(root.textContent).toContain('self lvl 9');
    // What the model did *not* get is as informative as what it did, so it is named rather than
    // being an absence somebody has to notice.
    expect(root.textContent).toContain('omitted: map');
    expect(root.textContent).toContain('Your ult is up.');
  });

  it('distinguishes a scenario from a question somebody asked', () => {
    // The load-bearing pill on this screen. `scenario.speak` renders through the same source and
    // lands in the same buffer, so without this the panel would offer a button press and a real
    // question as the same claim.
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn({ turnId: 'scenario_1', cause: 'system' })] }));
    expect(root.textContent).toContain('system');
  });

  it('shows the length of what the player said and never the words', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn({ playerSaidChars: 18 })] }));
    expect(root.textContent).toContain('player said 18 characters (not shown)');
  });
});

describe('tool calls (ADR-0047)', () => {
  const turnRow = (): HTMLElement | null => root.querySelector<HTMLElement>('.ins-turn');

  it('renders a replayed turn’s whole call trace, in the order it was made', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({
            tools: [
              call({ seq: 1, name: 'my_state', args: '{}', durationMs: 12 }),
              call({
                seq: 2,
                at: 9_500,
                name: 'enemy',
                args: '{"hero":"puck"}',
                result: '{"heroes":[{"hero":"puck"}]}',
                durationMs: 26,
              }),
            ],
          }),
        ],
      }),
    );

    const text = root.textContent;
    // Arguments and results both, because "it called `enemy`" and "it called `enemy` about puck and
    // got nothing back" are different readings of the same turn.
    expect(text).toContain('my_state');
    expect(text).toContain('{"hero":"puck"}');
    expect(text).toContain('{"heroes":[{"hero":"puck"}]}');
    // Oldest first: a turn's calls are read as a sequence, and the order it asked in is most of
    // what the sequence says.
    expect(text.indexOf('my_state')).toBeLessThan(text.indexOf('enemy'));
  });

  it('times each leg: to the first call, through the calls, to the answer', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({
            at: 9_000,
            closedAt: 11_000,
            tools: [
              call({ at: 9_400, durationMs: 12 }),
              call({ seq: 2, at: 9_600, durationMs: 26 }),
            ],
          }),
        ],
      }),
    );

    const text = root.textContent;
    expect(text).toContain('first call +400 ms');
    expect(text).toContain('2 calls 38 ms');
    // The leg the §10 risk is actually about: a round trip inside a spoken answer is audible in a
    // way it is not in text.
    expect(text).toContain('answered +2.0 s');
  });

  it('marks a turn that spoke without calling anything', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({ turns: [turn({ tools: [], agentSaid: 'You are ahead by two thousand.' })] }),
    );

    // The failure conversational-architecture.md §10 names: an answer that sounds grounded and was
    // not is the one thing nobody catches by listening.
    expect(turnRow()?.className).toContain('ins-turn--no-tools');
    expect(root.textContent).toContain('no tool call');
    expect(root.textContent).toContain('not grounded in the world model');
  });

  it('leaves a turn that called a tool unmarked', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn()] }));

    // The negative control. Without it the test above proves only that the class name exists.
    expect(turnRow()?.className).not.toContain('ins-turn--no-tools');
    expect(root.textContent).not.toContain('no tool call');
  });

  it('does not mark a turn that is still open', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn({ outcome: 'open', closedAt: null, tools: [] })] }));

    // A turn that has not answered yet has not answered *without* asking either, and flagging it
    // would put a red edge on every turn for the second it takes to run.
    expect(turnRow()?.className).not.toContain('ins-turn--no-tools');
    expect(root.textContent).toContain('the turn is still open');
  });

  it('counts the flagged turns in the panel title, because the rate is the reading', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({ turnId: 'voice_1' }),
          turn({ turnId: 'voice_2', tools: [] }),
          turn({ turnId: 'voice_3', tools: [] }),
        ],
      }),
    );

    // One ungrounded answer is a question that did not need the world; three of them is a prompt
    // that has stopped working.
    expect(root.textContent).toContain('2 of 3 turns called no tool');
  });

  it('shows a pending call as pending rather than as an instant one', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({
            outcome: 'open',
            closedAt: null,
            tools: [call({ status: 'pending', result: null, durationMs: null })],
          }),
        ],
      }),
    );

    const text = root.textContent;
    expect(text).toContain('pending');
    // A dash and not `0 ms`: this is the shape a hung dispatcher takes on this screen.
    expect(text).toContain('—');
  });

  it('says how many calls the cap dropped, rather than presenting the rest as all of them', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn({ toolsDropped: 3 })] }));
    expect(root.textContent).toContain('3 earlier calls dropped');
  });

  it('gives every call a key that survives the redraw', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn({ tools: [call({ seq: 7 })] })] }));

    expect(root.querySelector('.ins-tool')?.getAttribute('data-ins-key')).toBe('Turns/tool:7');
  });
});

describe('scenarios and the trace (ADR-0039)', () => {
  it('sends the id the button was drawn with, and predicts nothing', () => {
    const bridge = fakeBridge();
    const view = mountInspector(root, bridge);
    view.apply(frame({ actions: [ACTION] }));

    root
      .querySelector<HTMLElement>('[data-action="scenario.speak"]')
      ?.dispatchEvent(new Event('click', { bubbles: true }));

    // Sent and forgotten: the row turns to `running` because the *next* frame says so, which is the
    // same rule the overlay follows — the renderer draws what it is told.
    expect(bridge.sent).toContainEqual({ kind: 'action', id: 'scenario.speak' });
    expect(root.querySelector('[data-action]')?.hasAttribute('disabled')).toBe(false);
  });

  it('disables a row mid-run rather than letting it be pressed twice', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ actions: [{ ...ACTION, running: true }] }));
    // Main refuses the second press anyway; this is so the window says why rather than appearing
    // to ignore the click.
    expect(root.querySelector('[data-action]')?.hasAttribute('disabled')).toBe(true);
  });

  it('says so when there is no action port behind the panel', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ actions: [] }));
    expect(root.textContent).toContain('display but not run');
  });

  it('reads oldest first, and times a step against the run rather than the wall', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        trace: [
          step({ seq: 1, stage: 'scenario', message: 'started', sinceRunMs: 0 }),
          step({ seq: 2, stage: 'session', message: 'handed over', sinceRunMs: 1_250 }),
        ],
      }),
    );

    const text = root.textContent;
    expect(text.indexOf('started')).toBeLessThan(text.indexOf('handed over'));
    // "How long after the trigger" is the question a chain that stalls actually poses; a wall-clock
    // age answers a different one.
    expect(text).toContain('+1.3 s');
  });

  it('clears the trace through the bridge rather than locally', () => {
    const bridge = fakeBridge();
    const view = mountInspector(root, bridge);
    view.apply(frame({ trace: [step()] }));

    root
      .querySelector<HTMLElement>('[data-clear-trace]')
      ?.dispatchEvent(new Event('click', { bubbles: true }));

    // The buffer is main's. Clearing it here would leave the two disagreeing on the next frame.
    expect(bridge.sent).toContainEqual({ kind: 'clear-trace' });
    expect(root.textContent).toContain('push-to-talk');
  });
});

describe('honesty about nulls', () => {
  it('renders a null derived value as a declined answer, not a zero', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        world: {
          ...frame().world,
          derived: [{ id: 'buybackAffordable', value: null, confidence: null }],
        },
      }),
    );
    expect(root.textContent).toContain('inputs too stale to answer');
  });

  it('renders a missing clock as a dash, because 0:00 is a real moment', () => {
    expect(formatClock(null)).toBe('—');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(620)).toBe('10:20');
  });

  it('flags a live match with no session', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ session: { ...frame().session, matchSession: false } }));
    // The two disagree exactly when something is wrong, and every panel below looks plausibly
    // empty when it happens.
    expect(root.textContent).toContain('no session');
  });
});

describe('untrusted text', () => {
  it('escapes markup rather than parsing it', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        problems: [{ at: 9_000, origin: 'sidecar', message: '<img src=x> panicked' }],
      }),
    );
    // Everything on this screen came from a Dota client or a rendered snapshot. None of it is ours.
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x> panicked');
  });

  it('escapes markup in a snapshot too', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn({ snapshotText: '<img src=x>' })] }));
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x>');
  });
});

/**
 * The inspector's view, in an in-memory document.
 *
 * Tier 1 by REPO_SKELETON.md §5.2's rule — no game, no microphone, no GPU, no window — which is why
 * `desktop-renderer` is a Vitest project at all. Tier 5 is still the only place a real window
 * launches, and there is no harness for it yet.
 *
 * What is asserted is what somebody would be misled by if it were wrong: that the gate that decided
 * is distinguishable from the ones that merely would have, that a null reads as a null, and that
 * nothing on the screen came from `innerHTML`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  DebugCommand,
  DebugControl,
  DebugFrame,
  DebugIntent,
  DebugMockState,
  DebugTurn,
  RikiDebugBridge,
} from '../../shared/debug.js';
import { mountInspector } from './app.js';
import { isNotInMatchTick, formatClock } from './view.js';

// -------------------------------------------------------------------------------------------

const LADDER = [
  'not_in_match',
  'quiet_mode',
  'muted',
  'agent_speaking',
  'player_speaking',
  'high_intensity',
  'latched',
  'kind_cooldown',
  'global_cooldown',
  'already_advised',
  'ignored_twice',
  'stale_window',
  'below_threshold',
];

function ladder(refusing: readonly string[]): { reason: string; refuses: boolean }[] {
  return LADDER.map((reason) => ({ reason, refuses: refusing.includes(reason) }));
}

function frame(overrides: Partial<DebugFrame> = {}): DebugFrame {
  return {
    revision: 1,
    at: 10_000,
    session: {
      matchId: '789',
      coachingRoot: true,
      chipPhase: 'idle',
      chipVisible: false,
      muted: false,
      coachMode: 'static',
      gates: {
        asOfMs: 9_800,
        quietMode: false,
        agentSpeaking: false,
        playerSpeaking: false,
        mutedUntilMs: null,
        unprompted: true,
        intensity: 0.2,
        intensityThreshold: 0.6,
        speakThreshold: 0.4,
        lastSpokeAtMs: null,
        globalCooldownMs: 45_000,
        latched: [],
        kindCooldowns: [],
      },
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
    ticks: [],
    turns: [],
    counters: { detected: [], suppressed: [], spoken: 0, emptyBriefs: 0, ticks: 0 },
    problems: [],
    mocks: [],
    controls: [],
    actions: [],
    trace: [],
    ...overrides,
  };
}

/** One turn, defaulted to a real (not rehearsed) coaching turn — the shape most tests want. */
function turn(overrides: Partial<DebugTurn> = {}): DebugTurn {
  return {
    turnId: 'coach_1',
    at: 9_000,
    clock: 600,
    cause: 'trigger',
    eventId: 'ult_ready',
    salience: 0.8,
    snapshotText: 'clock 10:00',
    snapshotTokens: 42,
    briefText: 'your ult is up',
    briefTokens: 18,
    briefSections: ['cooldowns'],
    briefOmitted: [],
    briefEmpty: false,
    guidance: null,
    mockState: null,
    outcome: 'spoke',
    agentSaid: null,
    playerSaidChars: null,
    ...overrides,
  };
}

/**
 * One control, defaulted to the shape most tests want: a live, unlocked number.
 *
 * The registry in `main/debug/controls.ts` is the thing that decides what a real one looks like;
 * this exists so a view test can assert on one field without restating twelve.
 */
function control(overrides: Partial<DebugControl> = {}): DebugControl {
  return {
    id: 'trigger.speakThreshold',
    group: 'Thresholds',
    label: 'speak threshold',
    kind: 'number',
    value: 0.3,
    base: 0.3,
    overridden: false,
    min: 0,
    max: 1,
    step: 0.05,
    options: [],
    unit: null,
    note: null,
    locked: null,
    ...overrides,
  };
}

function tickWith(
  refusing: readonly string[],
  key = 'ult_ready:self',
): DebugFrame['ticks'][number] {
  return {
    seq: 1,
    at: 9_800,
    clock: 620,
    worldVersion: 12,
    candidates: [
      {
        kind: 'ult_ready',
        key,
        salience: 0.812,
        magnitude: 0.5,
        confidence: 0.9,
        actWithinSeconds: 12,
        text: 'your ult is up',
        taped: true,
        ladder: ladder(refusing),
        rank: 'winner',
      },
    ],
    decision:
      refusing.length === 0
        ? { speak: true, key }
        : { speak: false, reason: refusing[0] ?? 'below_threshold', key },
  };
}

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
 * focused control is invisible to every other test in this file. The modelled position is the
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
    bridge.emit({ kind: 'frame', frame: frame({ ticks: [tickWith(['latched'])] }) });
    expect(root.textContent).toContain('ult_ready:self');
  });

  it('says so when the app is shutting down', () => {
    const bridge = fakeBridge();
    mountInspector(root, bridge);
    bridge.emit({ kind: 'teardown' });
    expect(root.textContent).toContain('shutting down');
  });
});

describe('the gate ladder', () => {
  it('shows all thirteen gates, including the ones that passed', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ ticks: [tickWith(['latched'])] }));

    const gates = Array.from(root.querySelectorAll<HTMLElement>('.ins-gate'), (n) => n.textContent);
    // The gates that passed are as informative as the one that refused: twelve passes and a death
    // on `below_threshold` is a tuning problem; a death on gate 1 is not a coaching problem at all.
    expect(gates).toEqual(LADDER);
  });

  it('distinguishes the gate that decided from one that would also have refused', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ ticks: [tickWith(['latched', 'global_cooldown'])] }));

    const decided = Array.from(
      root.querySelectorAll<HTMLElement>('.ins-gate--refuse'),
      (node) => node.textContent,
    );
    const shadowed = Array.from(
      root.querySelectorAll<HTMLElement>('.ins-gate--shadowed'),
      (node) => node.textContent,
    );

    // §5.2 rule 3: the first refusal is the attributed one. Both are shown, because tuning the
    // first is wasted effort if the second is still there — which the counters cannot tell you.
    expect(decided).toEqual(['latched']);
    expect(shadowed).toEqual(['global_cooldown']);
  });

  it('marks a tick that spoke', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ ticks: [tickWith([])] }));
    expect(root.querySelector('.ins-tick--spoke')).not.toBeNull();
  });

  it('hides not_in_match ticks by default and says how many it hid', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        ticks: [tickWith(['not_in_match'])],
        counters: { detected: [], suppressed: [], spoken: 0, emptyBriefs: 0, ticks: 40 },
      }),
    );

    // Thousands of these are produced during a draft or a Turbo game and all of them are correct.
    // Without the filter the panel is a wall.
    expect(root.querySelectorAll('.ins-tick')).toHaveLength(0);
    expect(root.textContent).toContain('1 not_in_match tick hidden');
  });

  it('shows them when the filter is switched off', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ ticks: [tickWith(['not_in_match'])] }));

    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((each) =>
      each.textContent.includes('not_in_match'),
    );
    expect(button).toBeDefined();
    button?.dispatchEvent(new Event('click'));

    expect(root.querySelectorAll('.ins-tick')).toHaveLength(1);
  });
});

describe('the LLM coach', () => {
  /** What `hub.recordDecline` produces: a decision and nothing else. */
  const decline = (reason: string): DebugFrame['ticks'][number] => ({
    seq: 1,
    at: 9_800,
    clock: 620,
    worldVersion: 0,
    candidates: [],
    decision: { speak: false, reason, key: null },
  });

  it('renders a decline that has no ladder behind it', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        session: { ...frame().session, coachMode: 'llm' },
        ticks: [decline('the fight is already over; nothing useful to add')],
      }),
    );

    expect(root.textContent).toContain('the fight is already over');
    // No detectors, no salience, no gates — so no grid, and that is correct rather than missing.
    expect(root.querySelectorAll('.ins-gate')).toHaveLength(0);
    expect(root.querySelectorAll('.ins-tick')).toHaveLength(1);
  });

  it('says which coach is running, because it changes what the frame can contain', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ session: { ...frame().session, coachMode: 'llm' } }));
    expect(root.textContent).toContain('llm');
  });

  it('never hides a decline behind the not_in_match filter', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        session: { ...frame().session, coachMode: 'llm' },
        ticks: [decline('quiet for now')],
      }),
    );
    // The filter is about a gate the LLM coach does not have. A tick with no candidates can never
    // satisfy it, which is what keeps the default filter from blanking the panel in `llm` mode.
    expect(isNotInMatchTick(decline('quiet for now'))).toBe(false);
    expect(root.querySelectorAll('.ins-tick')).toHaveLength(1);
  });
});

describe('freeze', () => {
  it('holds the drawn frame while still accepting new ones', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ ticks: [tickWith(['latched'])] }));

    view.setFrozen(true);
    view.apply(frame({ revision: 2, ticks: [tickWith(['muted'], 'rune_soon:bounty')] }));
    expect(root.textContent).toContain('ult_ready:self');
    expect(root.textContent).not.toContain('rune_soon:bounty');

    // Unfreezing shows the present, not a resumed replay — main never stopped collecting.
    view.setFrozen(false);
    view.apply(frame({ revision: 3, ticks: [tickWith(['muted'], 'rune_soon:bounty')] }));
    expect(root.textContent).toContain('rune_soon:bounty');
  });

  it('drops a frame older than the one on screen', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ revision: 5, ticks: [tickWith(['latched'])] }));
    view.apply(frame({ revision: 4, ticks: [tickWith(['muted'], 'rune_soon:bounty')] }));
    // State appearing to go backwards is the single most misleading thing a debug window can do.
    expect(root.textContent).toContain('ult_ready:self');
  });
});

describe('live updates and the reader', () => {
  const columns = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('.ins-column'));

  it('keeps the same three scroll containers across a redraw', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ ticks: [tickWith(['latched'])] }));
    const before = columns();

    view.apply(frame({ revision: 2, ticks: [tickWith(['muted'], 'rune_soon:bounty')] }));

    // `scrollTop` belongs to the element. A column rebuilt from scratch arrives at the top with no
    // position to restore, and no amount of restoring afterwards can invent one.
    expect(columns()).toHaveLength(3);
    expect(columns()[0]).toBe(before[0]);
    expect(columns()[1]).toBe(before[1]);
    expect(columns()[2]).toBe(before[2]);
    // The contents are still redrawn whole, which is the part worth keeping.
    expect(root.textContent).toContain('rune_soon:bounty');
    expect(root.textContent).not.toContain('ult_ready:self');
  });

  it('does not send the reader back to the top when a frame arrives', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ ticks: [tickWith(['latched'])] }));

    const triggers = columns()[1];
    expect(triggers).toBeDefined();
    if (triggers === undefined) return;
    triggers.scrollTop = 240;

    view.apply(frame({ revision: 2, ticks: [tickWith(['muted'])] }));

    // The whole complaint, in one assertion: reading anything older than the newest tick was
    // impossible while the match was running, because 4 Hz of frames each rebuilt the column.
    expect(triggers.scrollTop).toBe(240);
  });

  it('does not take keyboard focus off a control mid-frame', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame());

    const freeze = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((each) =>
      each.textContent.includes('Freeze'),
    );
    expect(freeze).toBeDefined();
    freeze?.focus();

    view.apply(frame({ revision: 2 }));

    // The two buttons are the only focusable things on the screen, so a redraw that replaced them
    // would drop focus to `<body>` four times a second.
    expect(document.activeElement).toBe(freeze);
    expect(freeze?.getAttribute('aria-pressed')).toBe('false');
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
    view.apply(frame({ ticks: [tickWith(['latched'])] }));

    // Namespaced by panel, so `row:spoken` in Counters cannot be mistaken for a same-named row
    // elsewhere in the column when `scroll.ts` goes looking for it.
    expect(root.querySelector('.ins-tick')?.getAttribute('data-ins-key')).toBe('Triggers/tick:1');
    expect(root.querySelector('.ins-row')?.getAttribute('data-ins-key')).toBe(
      'Gate state/row:switches',
    );

    const keys = Array.from(root.querySelectorAll('[data-ins-key]'), (node) =>
      node.getAttribute('data-ins-key'),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('turns', () => {
  it('shows the snapshot and brief as rendered, and what Riki said', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({
            snapshotText: 'clock 10:00\nself lvl 9',
            briefOmitted: ['history'],
            agentSaid: 'Your ult is up — go.',
          }),
        ],
      }),
    );

    expect(root.textContent).toContain('clock 10:00');
    expect(root.textContent).toContain('your ult is up');
    expect(root.textContent).toContain('Your ult is up — go.');
    expect(root.textContent).toContain('omitted: history');
  });

  it('calls an empty brief what it is: admitted and dropped', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({
            turnId: 'coach_2',
            eventId: 'stack_now',
            salience: 0.5,
            briefText: '',
            briefTokens: 0,
            briefSections: [],
            briefEmpty: true,
            outcome: 'silent',
          }),
        ],
      }),
    );

    // The trigger cleared thirteen gates and produced nothing to say. That is a defect in
    // `BRIEF_PLAN` and it reads as ordinary silence everywhere else.
    expect(root.textContent).toContain('the turn was admitted and closed silent');
  });

  it('shows the length of what the player said and never the words', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({
            turnId: 'turn_1',
            cause: 'player',
            eventId: null,
            salience: null,
            briefText: 'wide',
            briefSections: ['positions'],
            playerSaidChars: 18,
          }),
        ],
      }),
    );

    expect(root.textContent).toContain('player said 18 characters (not shown)');
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

  it('flags a live match with no coaching root', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ session: { ...frame().session, coachingRoot: false } }));
    // The two disagree exactly when something is wrong, and every panel below looks plausibly
    // empty when it happens.
    expect(root.textContent).toContain('no coaching root');
  });

  it('says the gate panel is a still frame, not live', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame());
    expect(root.textContent).toContain('as of the last tick');
  });

  it('says when the engine has never ticked', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({ session: { ...frame().session, gates: { ...frame().session.gates, asOfMs: null } } }),
    );
    expect(root.textContent).toContain('the engine has not run');
  });
});

describe('the Controls panel (ADR-0037)', () => {
  /** The button whose `data-focus` key matches — the same handle `app.ts` restores focus by. */
  function button(key: string): HTMLElement {
    const found = root.querySelector(`[data-focus="${key}"]`);
    if (!(found instanceof HTMLElement)) throw new Error(`no control button ${key}`);
    return found;
  }

  function withControls(controls: readonly DebugControl[]): FakeBridge {
    const bridge = fakeBridge();
    const view = mountInspector(root, bridge);
    view.apply(frame({ controls }));
    return bridge;
  }

  it('sends a stepped value rather than applying it locally', () => {
    const bridge = withControls([control()]);

    button('trigger.speakThreshold:up').click();

    // Sent and then forgotten. The panel redraws from the next frame, so a value main clamped,
    // snapped or refused shows as what main decided rather than as what was clicked.
    expect(bridge.sent.at(-1)).toEqual({
      kind: 'control',
      id: 'trigger.speakThreshold',
      value: 0.35,
    });
    expect(root.textContent).toContain('0.3');
  });

  it('disables the stepper at the bound instead of sending past it', () => {
    const bridge = withControls([control({ value: 1, base: 1 })]);
    const up = button('trigger.speakThreshold:up');

    expect(up.hasAttribute('disabled')).toBe(true);
    up.click();
    expect(bridge.sent.filter((intent) => intent.kind === 'control')).toHaveLength(0);
  });

  it('sends the opposite of a switch, and the option of an enum', () => {
    const bridge = withControls([
      control({ id: 'gate.latched', group: 'Gates', kind: 'boolean', value: true, base: true }),
      control({
        id: 'coach.mode',
        group: 'Coach',
        kind: 'enum',
        value: 'static',
        base: 'static',
        options: ['static', 'llm'],
      }),
    ]);

    // `Gates` is collapsed by default — sixty settings do not fit in a column — so it is opened
    // the way a person would open it.
    button('group:Gates').click();
    button('gate.latched:toggle').click();
    button('coach.mode:llm').click();

    expect(bridge.sent.at(-2)).toEqual({ kind: 'control', id: 'gate.latched', value: false });
    expect(bridge.sent.at(-1)).toEqual({ kind: 'control', id: 'coach.mode', value: 'llm' });
  });

  it('renders a locked control and gives it nothing to click', () => {
    const bridge = withControls([
      control({
        id: 'gate.muted',
        group: 'Gates',
        kind: 'boolean',
        value: true,
        base: true,
        locked: 'the player muted Riki',
      }),
    ]);

    button('group:Gates').click();

    // Displayed, not hidden: "why can I not turn this off" is a question the window should answer
    // where it is asked, and a control that is simply absent invites somebody to add it.
    expect(root.textContent).toContain('the player muted Riki');
    expect(root.textContent).toContain('locked');
    expect(root.querySelector('[data-focus="gate.muted:toggle"]')).toBeNull();
    expect(bridge.sent.filter((intent) => intent.kind === 'control')).toHaveLength(0);
  });

  it('shows an override against its config value, and offers a way back', () => {
    const bridge = withControls([control({ value: 0.05, overridden: true })]);

    expect(root.textContent).toContain('config 0.3');
    expect(root.textContent).toContain('1 override');

    button('trigger.speakThreshold:reset').click();
    expect(bridge.sent.at(-1)).toEqual({
      kind: 'control',
      id: 'trigger.speakThreshold',
      value: 0.3,
    });
  });

  it('counts every override in the header, where it cannot be missed', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        controls: [
          control({ overridden: true }),
          control({ id: 'trigger.tapeSalience', overridden: true }),
          control({ id: 'trigger.globalCooldownMs' }),
        ],
      }),
    );

    // The realistic failure this panel introduces is somebody moving a threshold, forgetting, and
    // reporting that Riki will not stop talking. The header is where that is caught.
    expect(root.querySelector('.ins-header')?.textContent).toContain('2 overrides');
  });

  it('resets everything from one button, and disables it when there is nothing to reset', () => {
    const clean = withControls([control()]);
    button('reset:all').click();
    expect(clean.sent.filter((intent) => intent.kind === 'reset-controls')).toHaveLength(0);

    const dirty = withControls([control({ overridden: true })]);
    button('reset:all').click();
    expect(dirty.sent.at(-1)).toEqual({ kind: 'reset-controls' });
  });

  it('collapses a group without telling main, and keeps it collapsed across a frame', () => {
    const bridge = fakeBridge();
    const view = mountInspector(root, bridge);
    const controls = [control()];
    view.apply(frame({ controls }));

    // Asserted on the stepper rather than on the label, because "speak threshold" is also a row in
    // the Gate state panel below — which is the point of showing both, and would make a
    // `textContent` assertion here pass for the wrong reason.
    expect(root.querySelector('[data-focus="trigger.speakThreshold:up"]')).not.toBeNull();
    button('group:Thresholds').click();

    // Group expansion is view state and never leaves the renderer — a debug window's scroll
    // position is not something main should know about.
    expect(root.querySelector('[data-focus="trigger.speakThreshold:up"]')).toBeNull();
    expect(bridge.sent.filter((intent) => intent.kind === 'control')).toHaveLength(0);

    view.apply(frame({ revision: 2, controls }));
    expect(root.querySelector('[data-focus="trigger.speakThreshold:up"]')).toBeNull();
  });

  it('leaves a group the registry names but the view does not, visible', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ controls: [control({ group: 'Something new' })] }));
    // A group added to the registry must render even before the view's ordering list knows about
    // it — the panel is self-describing, and a hard-coded list that dropped one would defeat that.
    expect(root.textContent).toContain('Something new');
  });

  it('puts focus back on the button that had it after a redraw', () => {
    const view = mountInspector(root, fakeBridge());
    const controls = [control()];
    view.apply(frame({ controls }));

    button('trigger.speakThreshold:up').focus();
    view.apply(frame({ revision: 2, controls }));

    // Without this, holding down `+` while the pump ticks moves focus to the document body four
    // times a second, and the panel is unusable from a keyboard.
    expect(document.activeElement).toBe(button('trigger.speakThreshold:up'));
  });

  it('does not drag the column back to the focused control on every frame', () => {
    const restore = modelFocusScrolling();
    try {
      const view = mountInspector(root, fakeBridge());
      const controls = [control()];
      view.apply(frame({ controls }));

      const state = root.querySelector<HTMLElement>('.ins-column');
      expect(state).not.toBeNull();
      if (state === null) return;

      // Touch a control, then go and read what it did to the gates and the world model — which are
      // panels below Controls in the same scrolling column.
      button('trigger.speakThreshold:up').click();
      button('trigger.speakThreshold:up').focus();
      state.scrollTop = 600;

      view.apply(frame({ revision: 2, controls }));

      // `scroll.ts` puts the reader back and then focus restoration takes them away again: the
      // control that still holds focus is in the first panel, so scrolling it into view is
      // scrolling to the top. At 4 Hz the column cannot be scrolled away from that control at all.
      expect(state.scrollTop).toBe(600);
    } finally {
      restore();
    }
  });

  it('says so when there is no control port behind the panel', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ controls: [] }));
    expect(root.textContent).toContain('display but not change');
  });
});

describe('the Rehearsal panel (ADR-0038)', () => {
  function mock(overrides: Partial<DebugMockState> = {}): DebugMockState {
    return {
      id: 'laning-phase',
      label: 'laning phase',
      note: 'SYNTHETIC — assembled from the component list',
      observations: 12,
      ...overrides,
    };
  }

  const draft = mock({ id: 'draft', label: 'draft', observations: 4 });

  /** The button carrying this `data-focus` key, or a throw naming what was missing. */
  function button(key: string): HTMLElement {
    const found = root.querySelector(`[data-focus="${key}"]`);
    if (!(found instanceof HTMLElement)) throw new Error(`no button ${key}`);
    return found;
  }

  function withMocks(mocks: readonly DebugMockState[]): FakeBridge {
    const bridge = fakeBridge();
    const view = mountInspector(root, bridge);
    view.apply(frame({ mocks }));
    return bridge;
  }

  it('rehearses the first state offered, before anything has been picked', () => {
    const bridge = withMocks([mock(), draft]);

    // The dropdown shows a selection from the first frame, so the button has to mean it. Sending
    // `null` here — the literal value of `options.selectedMock` — would be a button whose label and
    // effect disagreed.
    expect(button('mock:toggle').textContent).toContain('laning phase');
    button('rehearse').click();

    expect(bridge.sent.at(-1)).toEqual({ kind: 'rehearse', stateId: 'laning-phase' });
  });

  it('opens the dropdown, picks a state, and closes on the choice', () => {
    const bridge = withMocks([mock(), draft]);

    // Collapsed until asked: sixty-four scenarios is a panel, not a row.
    expect(root.querySelector('[data-focus="mock:draft"]')).toBeNull();

    button('mock:toggle').click();
    expect(button('mock:draft').getAttribute('aria-pressed')).toBe('false');

    button('mock:draft').click();
    expect(root.querySelector('[data-focus="mock:draft"]')).toBeNull();
    expect(button('mock:toggle').textContent).toContain('draft');

    // Choosing is view state and never leaves the renderer — only the run does.
    expect(bridge.sent.filter((intent) => intent.kind === 'rehearse')).toHaveLength(0);

    button('rehearse').click();
    expect(bridge.sent.at(-1)).toEqual({ kind: 'rehearse', stateId: 'draft' });
  });

  it('falls back when the selected state is renamed out from under it', () => {
    const bridge = fakeBridge();
    const view = mountInspector(root, bridge);
    view.apply(frame({ mocks: [mock(), draft] }));

    button('mock:toggle').click();
    button('mock:draft').click();
    expect(button('mock:toggle').textContent).toContain('draft');

    // The library is a directory read at 4 Hz, so a fixture can be deleted while the window is
    // open. Holding the selection would leave a button that rehearses nothing and says only that
    // it could not find it.
    view.apply(frame({ revision: 2, mocks: [mock()] }));
    expect(button('mock:toggle').textContent).toContain('laning phase');

    button('rehearse').click();
    expect(bridge.sent.at(-1)).toEqual({ kind: 'rehearse', stateId: 'laning-phase' });
  });

  it('says how to populate an empty library, and offers nothing to click', () => {
    const bridge = withMocks([]);

    // A packaged build and an empty `fixtures/gsi/` are the same picture, and one of them is fixed
    // by adding a file.
    expect(root.textContent).toContain('add a .jsonl to fixtures/gsi/');
    expect(root.querySelector('[data-focus="rehearse"]')).toBeNull();
    expect(bridge.sent.filter((intent) => intent.kind === 'rehearse')).toHaveLength(0);
  });

  it('keeps the dropdown open across a frame, and the selection with it', () => {
    const bridge = fakeBridge();
    const view = mountInspector(root, bridge);
    view.apply(frame({ mocks: [mock(), draft] }));

    button('mock:toggle').click();
    view.apply(frame({ revision: 2, mocks: [mock(), draft] }));

    // The document is rebuilt whole four times a second. Anything the DOM would normally remember
    // has to be held outside it, which is why this is view state in `app.ts` and not a `<select>`.
    expect(root.querySelector('[data-focus="mock:draft"]')).not.toBeNull();
    expect(button('mock:toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the coach output and marks the turn as rehearsed, not spoken', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(
      frame({
        turns: [
          turn({
            turnId: 'rehearsal_1',
            cause: 'rehearsal',
            mockState: 'laning-phase',
            guidance: 'back off — their jungler is missing',
            outcome: 'rehearsed',
            agentSaid: null,
          }),
        ],
      }),
    );

    // The whole of what the feature is for: the coach's text, in the panel, without a match.
    expect(root.textContent).toContain('back off — their jungler is missing');
    expect(root.textContent).toContain('coach drafted');
    // And the pill that stops a fabricated moment being read as a played one.
    expect(root.textContent).toContain('mock: laning-phase');
    expect(root.textContent).toContain('rehearsed');
    expect(root.querySelector('.ins-text--guidance')).not.toBeNull();
    // `riki said` is a transcript, and nothing spoke.
    expect(root.textContent).not.toContain('riki said');
  });

  it('leaves a real turn unmarked', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ turns: [turn({ agentSaid: 'Your ult is up — go.' })] }));

    expect(root.textContent).toContain('riki said');
    expect(root.textContent).not.toContain('mock:');
    expect(root.querySelector('.ins-text--guidance')).toBeNull();
  });

  it('escapes a mock state name rather than parsing it', () => {
    const view = mountInspector(root, fakeBridge());
    view.apply(frame({ mocks: [mock({ id: '<img src=x>', label: '<img src=x>' })] }));

    // A mock state's name is a file name off disk, which is no more ours than a hero name is.
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x>');
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
    // Everything on this screen came from a Dota client, a detector's phrasing or a rendered brief.
    // None of it is ours.
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x> panicked');
  });
});

describe('isNotInMatchTick', () => {
  it('is false when any candidate got past gate 1', () => {
    const tick = tickWith(['latched']);
    expect(isNotInMatchTick(tick)).toBe(false);
    expect(isNotInMatchTick(tickWith(['not_in_match']))).toBe(true);
    expect(isNotInMatchTick({ ...tick, candidates: [] })).toBe(false);
  });
});

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

import type { DebugCommand, DebugFrame, DebugIntent, RikiDebugBridge } from '../../shared/debug.js';
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
          {
            turnId: 'coach_1',
            at: 9_000,
            clock: 600,
            cause: 'trigger',
            eventId: 'ult_ready',
            salience: 0.8,
            snapshotText: 'clock 10:00\nself lvl 9',
            snapshotTokens: 42,
            briefText: 'your ult is up',
            briefTokens: 18,
            briefSections: ['cooldowns'],
            briefOmitted: ['history'],
            briefEmpty: false,
            outcome: 'spoke',
            agentSaid: 'Your ult is up — go.',
            playerSaidChars: null,
          },
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
          {
            turnId: 'coach_2',
            at: 9_000,
            clock: 600,
            cause: 'trigger',
            eventId: 'stack_now',
            salience: 0.5,
            snapshotText: 'clock 10:00',
            snapshotTokens: 20,
            briefText: '',
            briefTokens: 0,
            briefSections: [],
            briefOmitted: [],
            briefEmpty: true,
            outcome: 'silent',
            agentSaid: null,
            playerSaidChars: null,
          },
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
          {
            turnId: 'turn_1',
            at: 9_000,
            clock: 600,
            cause: 'player',
            eventId: null,
            salience: null,
            snapshotText: 'clock 10:00',
            snapshotTokens: 20,
            briefText: 'wide',
            briefTokens: 4,
            briefSections: ['positions'],
            briefOmitted: [],
            briefEmpty: false,
            outcome: 'spoke',
            agentSaid: null,
            playerSaidChars: 18,
          },
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

import { describe, expect, it } from 'vitest';

import type { ChipState } from '../../shared/overlay.js';
import {
  ACCENTS,
  GLYPHS,
  MOTIONS,
  chipStateOf,
  initial,
  projectChip,
  projectTray,
  reduce,
} from './machine.js';
import {
  CANCEL_HINT_MS,
  DEFAULT_ENVIRONMENT,
  ELAPSED_HINT_MS,
  ERROR_DISMISS_MS,
  HIDE_HOLD_MS,
} from './timing.js';
import type { ConfirmPrompt, Effect, Fault, MachineInput, MachineState, TimerId } from './types.js';

const ENV = DEFAULT_ENVIRONMENT;

const PROMPT: ConfirmPrompt = {
  id: 'c1',
  question: 'Look at your screen?',
  action: 'read-screen',
};

const MIC_DENIED: Fault = {
  kind: 'mic-denied',
  persistent: true,
  message: 'Microphone blocked',
};

const OFFLINE: Fault = { kind: 'offline', persistent: false, message: 'Offline' };

// --- driving ----------------------------------------------------------------------------------

interface Run {
  readonly state: MachineState;
  readonly effects: readonly Effect[];
}

/** Applies a script of `[input, now]` pairs, returning the final state and the last step's effects. */
function drive(script: readonly (readonly [MachineInput, number])[], from = initial(ENV, 0)): Run {
  let state = from;
  let effects: readonly Effect[] = [];
  for (const [input, now] of script) {
    const transition = reduce(state, input, now);
    state = transition.state;
    effects = transition.effects;
  }
  return { state, effects };
}

const down = (now: number): readonly [MachineInput, number] => [
  { kind: 'trigger', event: { kind: 'down' } },
  now,
];
const up = (now: number): readonly [MachineInput, number] => [
  { kind: 'trigger', event: { kind: 'up' } },
  now,
];
const tap = (now: number): readonly [MachineInput, number] => [
  { kind: 'trigger', event: { kind: 'tap' } },
  now,
];
const audio = (now: number): readonly [MachineInput, number] => [
  { kind: 'capture', event: 'firstAudio' },
  now,
];
const timer = (id: TimerId, now: number): readonly [MachineInput, number] => [
  { kind: 'timer', id },
  now,
];

/** The scripts that reach each phase, so tests can enumerate phases rather than list them. */
const REACH = {
  idle: [] as readonly (readonly [MachineInput, number])[],
  armed: [down(0)],
  listening: [down(0), audio(10)],
  processing: [down(0), audio(10), up(500)],
  acting: [
    down(0),
    audio(10),
    up(500),
    [{ kind: 'tool', event: 'started', verb: 'reading' }, 600] as const,
  ],
  confirming: [
    down(0),
    audio(10),
    up(500),
    [{ kind: 'consent', event: 'requested', prompt: PROMPT }, 600] as const,
  ],
  speaking: [
    down(0),
    audio(10),
    up(500),
    [{ kind: 'turn', event: 'responseStarted' }, 900] as const,
  ],
  error: [[{ kind: 'fault', fault: OFFLINE }, 100] as const],
} as const;

const PHASES = Object.keys(REACH) as readonly (keyof typeof REACH)[];

function has(effects: readonly Effect[], match: Partial<Effect>): boolean {
  return effects.some((effect) =>
    Object.entries(match).every(
      ([key, value]) => (effect as unknown as Record<string, unknown>)[key] === value,
    ),
  );
}

// --- the table --------------------------------------------------------------------------------

describe('reduce — reaching each phase', () => {
  it.each(PHASES)('%s is reachable', (phase) => {
    const { state } = drive(REACH[phase]);
    expect(state.phase.kind).toBe(phase);
  });
});

describe('reduce — the 100 ms path', () => {
  it('shows the window on key-down, before anything else in the effect list', () => {
    const { effects } = drive([down(0)]);
    expect(effects[0]).toEqual({ kind: 'window', visible: true });
  });

  it('arms without waiting for the audio device', () => {
    const { state } = drive([down(0)]);
    expect(state.phase).toEqual({ kind: 'armed', gesture: 'push' });
  });

  it('starts the level pump while still Armed, so the bars are warm', () => {
    const { effects } = drive([down(0)]);
    expect(has(effects, { kind: 'levels', running: true, source: 'input' })).toBe(true);
  });

  it('sounds the capture-start earcon', () => {
    const { effects } = drive([down(0)]);
    expect(has(effects, { kind: 'earcon', sound: 'capture-start' })).toBe(true);
  });
});

describe('reduce — capture', () => {
  it('enters Listening on the first audio, not on the device opening', () => {
    const opened = drive([down(0), [{ kind: 'capture', event: 'opened' }, 5]]);
    expect(opened.state.phase.kind).toBe('armed');
    expect(opened.effects).toEqual([]);

    const heard = drive([down(0), audio(10)]);
    expect(heard.state.phase.kind).toBe('listening');
  });

  it('keeps the listen timeout across Armed → Listening rather than restarting it', () => {
    const { effects } = drive([down(0), audio(10)]);
    expect(has(effects, { kind: 'cancel', id: 'listen-timeout' })).toBe(false);
    expect(has(effects, { kind: 'schedule', id: 'listen-timeout' })).toBe(false);
  });

  it('returns to Idle when the device goes away mid-capture', () => {
    const { state, effects } = drive([
      down(0),
      audio(10),
      [{ kind: 'capture', event: 'closed' }, 20],
    ]);
    expect(state.phase.kind).toBe('idle');
    expect(has(effects, { kind: 'earcon', sound: 'capture-end' })).toBe(true);
  });

  it('ignores a close that arrives after the turn was already submitted', () => {
    const { state, effects } = drive([
      down(0),
      audio(10),
      up(500),
      [{ kind: 'capture', event: 'closed' }, 510],
    ]);
    expect(state.phase.kind).toBe('processing');
    expect(effects).toEqual([]);
  });
});

describe('reduce — push and latch', () => {
  it('release submits the utterance and sounds the capture-end earcon', () => {
    const { state, effects } = drive([down(0), audio(10), up(500)]);
    expect(state.phase).toEqual({ kind: 'processing', startedAt: 500 });
    expect(has(effects, { kind: 'earcon', sound: 'capture-end' })).toBe(true);
    expect(has(effects, { kind: 'levels', running: false })).toBe(true);
  });

  it('release before any audio submits nothing', () => {
    const { state } = drive([down(0), up(120)]);
    expect(state.phase.kind).toBe('idle');
  });

  it('a latched capture ignores the release and ends on the next tap', () => {
    const held = drive([tap(0), audio(10), up(500)]);
    expect(held.state.phase.kind).toBe('listening');
    expect(held.state.latched).toBe(true);

    const ended = drive([tap(0), audio(10), up(500), tap(900)]);
    expect(ended.state.phase.kind).toBe('processing');
  });

  it('a latched session returns to Listening when Riki stops speaking', () => {
    const { state } = drive([
      tap(0),
      audio(10),
      tap(500),
      [{ kind: 'turn', event: 'responseStarted' }, 900],
      [{ kind: 'turn', event: 'responseEnded' }, 3_000],
    ]);
    expect(state.phase).toEqual({ kind: 'listening', gesture: 'latch', silentSince: null });
  });

  it('a push session hides when Riki stops speaking', () => {
    const { state, effects } = drive([
      down(0),
      audio(10),
      up(500),
      [{ kind: 'turn', event: 'responseStarted' }, 900],
      [{ kind: 'turn', event: 'responseEnded' }, 3_000],
    ]);
    expect(state.phase.kind).toBe('idle');
    expect(has(effects, { kind: 'window', visible: false })).toBe(true);
  });
});

describe('reduce — barge-in', () => {
  it('goes straight to Listening with one interrupt, and no intermediate Armed', () => {
    const { state, effects } = drive([...REACH.speaking, down(1_200)]);

    expect(state.phase).toEqual({ kind: 'listening', gesture: 'push', silentSince: null });
    expect(effects.filter((e) => e.kind === 'voice')).toEqual([
      { kind: 'voice', command: { kind: 'interrupt', at: 1_200 } },
    ]);
    expect(has(effects, { kind: 'duck', on: false })).toBe(true);
    expect(has(effects, { kind: 'levels', running: true, source: 'input' })).toBe(true);
    expect(has(effects, { kind: 'earcon', sound: 'capture-start' })).toBe(true);
  });

  it('works identically out of unprompted speech', () => {
    const { state, effects } = drive([
      [{ kind: 'unprompted', event: 'speechStarted' }, 100],
      down(1_200),
    ]);
    expect(state.phase.kind).toBe('listening');
    expect(has(effects, { kind: 'voice' })).toBe(true);
  });
});

describe('reduce — unprompted speech', () => {
  it('enters Speaking from Idle with no earcon and no Armed', () => {
    const { state, effects } = drive([[{ kind: 'unprompted', event: 'speechStarted' }, 100]]);
    expect(state.phase).toEqual({ kind: 'speaking', unprompted: true });
    expect(effects[0]).toEqual({ kind: 'window', visible: true });
    expect(has(effects, { kind: 'earcon' })).toBe(false);
    expect(has(effects, { kind: 'duck', on: true })).toBe(true);
  });

  it('never interrupts an interaction already in progress', () => {
    const { state } = drive([
      ...REACH.listening,
      [{ kind: 'unprompted', event: 'speechStarted' }, 50],
    ]);
    expect(state.phase.kind).toBe('listening');
  });

  it('is suppressed while muted', () => {
    const { state } = drive([
      [{ kind: 'mute', muted: true }, 0],
      [{ kind: 'unprompted', event: 'speechStarted' }, 100],
    ]);
    expect(state.phase.kind).toBe('idle');
  });
});

describe('reduce — Esc from every phase', () => {
  it.each(PHASES.filter((p) => p !== 'idle'))('cancels from %s', (phase) => {
    const { state, effects } = drive([
      ...REACH[phase],
      [{ kind: 'trigger', event: { kind: 'cancel' } }, 5_000],
    ]);
    expect(state.phase.kind).toBe('idle');
    expect(state.latched).toBe(false);
    expect(has(effects, { kind: 'voice' })).toBe(true);
    expect(has(effects, { kind: 'window', visible: false })).toBe(true);
  });

  it('is a denial *and* a cancel while Confirming — unlike answering N', () => {
    const escaped = drive([
      ...REACH.confirming,
      [{ kind: 'trigger', event: { kind: 'cancel' } }, 5_000],
    ]);
    expect(escaped.effects).toContainEqual({
      kind: 'voice',
      command: { kind: 'consent', promptId: 'c1', granted: false },
    });
    expect(escaped.effects).toContainEqual({ kind: 'voice', command: { kind: 'abort' } });
    expect(escaped.state.phase.kind).toBe('idle');

    // N is "no, but carry on", so the turn survives it.
    const answered = drive([
      ...REACH.confirming,
      [{ kind: 'trigger', event: { kind: 'confirm', answer: false } }, 5_000],
    ]);
    expect(answered.state.phase.kind).toBe('processing');
  });

  it('does nothing at rest', () => {
    const { effects } = drive([[{ kind: 'trigger', event: { kind: 'cancel' } }, 100]]);
    expect(effects).toEqual([]);
  });
});

describe('reduce — leaving a visible phase', () => {
  it.each(PHASES.filter((p) => p !== 'idle'))('stops the level pump when %s ends', (phase) => {
    const { effects } = drive([
      ...REACH[phase],
      [{ kind: 'trigger', event: { kind: 'cancel' } }, 5_000],
    ]);
    expect(has(effects, { kind: 'levels', running: false })).toBe(true);
  });

  it('always carries the 400 ms hold on the hide', () => {
    for (const phase of PHASES.filter((p) => p !== 'idle')) {
      const { effects } = drive([
        ...REACH[phase],
        [{ kind: 'trigger', event: { kind: 'cancel' } }, 5_000],
      ]);
      const hides = effects.filter((e) => e.kind === 'window' && !e.visible);
      expect(hides).toEqual([{ kind: 'window', visible: false, holdMs: HIDE_HOLD_MS }]);
    }
  });

  it('cancels every pending timer', () => {
    const { state } = drive([
      ...REACH.processing,
      [{ kind: 'trigger', event: { kind: 'cancel' } }, 5_000],
    ]);
    expect(state.pending).toEqual([]);
  });
});

describe('reduce — mute', () => {
  it.each(['down', 'up', 'tap'] as const)('suppresses the %s gesture', (kind) => {
    const { state, effects } = drive([
      [{ kind: 'mute', muted: true }, 0],
      [{ kind: 'trigger', event: { kind } }, 100],
    ]);
    expect(state.phase.kind).toBe('idle');
    expect(effects).toEqual([]);
  });

  it('shows the grey dot rather than hiding', () => {
    const { effects } = drive([[{ kind: 'mute', muted: true }, 0]]);
    expect(has(effects, { kind: 'window', visible: true })).toBe(true);
    expect(has(effects, { kind: 'window', visible: false })).toBe(false);
  });

  it('aborts an interaction in flight', () => {
    const { state, effects } = drive([...REACH.listening, [{ kind: 'mute', muted: true }, 100]]);
    expect(state.phase.kind).toBe('idle');
    expect(effects).toContainEqual({ kind: 'voice', command: { kind: 'abort' } });
  });

  it('hides the dot again on unmute', () => {
    const { effects } = drive([
      [{ kind: 'mute', muted: true }, 0],
      [{ kind: 'mute', muted: false }, 100],
    ]);
    expect(has(effects, { kind: 'window', visible: false })).toBe(true);
  });

  it('ignores a mute that changes nothing', () => {
    const { effects } = drive([[{ kind: 'mute', muted: false }, 0]]);
    expect(effects).toEqual([]);
  });
});

describe('reduce — faults', () => {
  it('reports a persistent fault once and then transitions silently', () => {
    const first = drive([[{ kind: 'fault', fault: MIC_DENIED }, 100]]);
    expect(first.state.phase.kind).toBe('error');
    expect(has(first.effects, { kind: 'earcon', sound: 'error' })).toBe(true);

    const second = reduce(first.state, { kind: 'fault', fault: MIC_DENIED }, 200);
    expect(second.effects).toEqual([]);
    expect(second.state.phase.kind).toBe('error');
  });

  it('repeats a non-persistent fault, because a second one is news', () => {
    const first = drive([[{ kind: 'fault', fault: OFFLINE }, 100]]);
    const second = reduce(first.state, { kind: 'fault', fault: OFFLINE }, 200);
    expect(has(second.effects, { kind: 'earcon', sound: 'error' })).toBe(true);
  });

  it('forgets what it reported once audio arrives again', () => {
    const denied = drive([[{ kind: 'fault', fault: MIC_DENIED }, 100]]);
    expect(denied.state.reported).toEqual(['mic-denied']);

    const recovered = drive([down(5_000), audio(5_010)], denied.state);
    expect(recovered.state.reported).toEqual([]);
  });

  it('keeps the tray on attention after the Error chip has faded', () => {
    const dismissed = drive([
      [{ kind: 'fault', fault: MIC_DENIED }, 100],
      down(200),
      [{ kind: 'fault', fault: MIC_DENIED }, 210],
    ]);
    // Second report: silent, straight back to Idle, chip gone.
    expect(dismissed.state.phase.kind).toBe('idle');
    expect(projectTray(dismissed.state)).toBe('attention');
  });

  it('auto-dismisses a transient fault and holds a persistent one', () => {
    const transient = drive([
      [{ kind: 'fault', fault: OFFLINE }, 100],
      timer('error-dismiss', 100 + ERROR_DISMISS_MS),
    ]);
    expect(transient.state.phase.kind).toBe('idle');

    const persistent = drive([
      [{ kind: 'fault', fault: MIC_DENIED }, 100],
      timer('error-dismiss', 100 + ERROR_DISMISS_MS),
    ]);
    expect(persistent.state.phase.kind).toBe('error');
    expect(persistent.effects).toEqual([]);
  });

  it('schedules no dismissal for a persistent fault at all', () => {
    const { effects } = drive([[{ kind: 'fault', fault: MIC_DENIED }, 100]]);
    expect(has(effects, { kind: 'schedule', id: 'error-dismiss' })).toBe(false);
  });

  it('re-arms on the key, because the chip has no clickable Fix button', () => {
    for (const fault of [MIC_DENIED, OFFLINE]) {
      const { state } = drive([[{ kind: 'fault', fault }, 100], down(200)]);
      expect(state.phase.kind).toBe('armed');
    }
  });

  it('costs one silent return to Idle when the retry fails the same way', () => {
    const retried = drive([
      [{ kind: 'fault', fault: MIC_DENIED }, 100],
      down(200),
      [{ kind: 'fault', fault: MIC_DENIED }, 210],
    ]);
    expect(retried.state.phase.kind).toBe('idle');
    expect(has(retried.effects, { kind: 'earcon' })).toBe(false);
  });
});

describe('reduce — consent', () => {
  it('grabs the confirm keys on entry and releases them on exit', () => {
    const entering = drive(REACH.confirming);
    expect(entering.effects).toContainEqual({ kind: 'keys', grab: ['yes', 'no', 'escape'] });

    const leaving = drive([
      ...REACH.confirming,
      [{ kind: 'trigger', event: { kind: 'confirm', answer: true } }, 700],
    ]);
    expect(leaving.effects).toContainEqual({ kind: 'keys', grab: [] });
  });

  it('sends the answer and returns to Processing', () => {
    const { state, effects } = drive([
      ...REACH.confirming,
      [{ kind: 'trigger', event: { kind: 'confirm', answer: true } }, 700],
    ]);
    expect(effects).toContainEqual({
      kind: 'voice',
      command: { kind: 'consent', promptId: 'c1', granted: true },
    });
    expect(state.phase).toEqual({ kind: 'processing', startedAt: 700 });
  });

  it('resolves to denied when the prompt times out', () => {
    const { state, effects } = drive([
      ...REACH.confirming,
      timer('confirm-timeout', 600 + ENV.confirmTimeoutMs),
    ]);
    expect(effects).toContainEqual({
      kind: 'voice',
      command: { kind: 'consent', promptId: 'c1', granted: false },
    });
    expect(state.phase.kind).toBe('processing');
  });

  it('blocks the capture gesture while it waits', () => {
    const { state, effects } = drive([...REACH.confirming, down(700)]);
    expect(state.phase.kind).toBe('confirming');
    expect(effects).toEqual([]);
  });

  it('accepts the same answer from the renderer as from the keyboard', () => {
    const { effects } = drive([
      ...REACH.confirming,
      [{ kind: 'intent', intent: { kind: 'confirm', answer: false } }, 700],
    ]);
    expect(effects).toContainEqual({
      kind: 'voice',
      command: { kind: 'consent', promptId: 'c1', granted: false },
    });
  });
});

describe('reduce — timers', () => {
  it('schedules the nudge and the timeout from the environment, not from constants', () => {
    const env = { ...ENV, silenceNudgeMs: 3_000, listenTimeoutMs: 30_000 };
    const armed = drive([down(0)], initial(env, 0));
    expect(armed.effects).toContainEqual({
      kind: 'schedule',
      id: 'listen-timeout',
      delayMs: 30_000,
    });

    const silent = drive(
      [down(0), audio(10), [{ kind: 'speech', event: 'silence' }, 400]],
      initial(env, 0),
    );
    expect(silent.effects).toContainEqual({
      kind: 'schedule',
      id: 'silence-nudge',
      delayMs: 3_000,
    });
  });

  it('dims after the nudge and undims when speech resumes', () => {
    const silent = drive([
      down(0),
      audio(10),
      [{ kind: 'speech', event: 'silence' }, 400],
      timer('silence-nudge', 400 + ENV.silenceNudgeMs),
    ]);
    expect(projectChip(silent.state, 400 + ENV.silenceNudgeMs).dimmed).toBe(true);

    const resumed = drive([[{ kind: 'speech', event: 'resumed' }, 2_000]], silent.state);
    expect(projectChip(resumed.state, 2_000).dimmed).toBe(false);
  });

  it('cancels the pending nudge when speech resumes before it fires', () => {
    const { effects } = drive([
      down(0),
      audio(10),
      [{ kind: 'speech', event: 'silence' }, 400],
      [{ kind: 'speech', event: 'resumed' }, 800],
    ]);
    expect(has(effects, { kind: 'cancel', id: 'silence-nudge' })).toBe(true);
  });

  it('turns a listening timeout into an error rather than a silent drop', () => {
    const { state } = drive([down(0), audio(10), timer('listen-timeout', ENV.listenTimeoutMs)]);
    expect(state.phase).toEqual({
      kind: 'error',
      fault: { kind: 'no-speech-detected', persistent: false, message: "Didn't catch that" },
    });
  });

  it('surfaces the elapsed counter at 2.5 s and the cancel hint at 10 s', () => {
    const { state } = drive(REACH.processing);
    const at = (offset: number) => projectChip(state, 500 + offset);

    expect(at(0).text).toBeNull();
    expect(at(ELAPSED_HINT_MS).text).toEqual({ primary: '', elapsedMs: ELAPSED_HINT_MS });
    expect(at(ELAPSED_HINT_MS).affordances).toEqual([]);
    expect(at(CANCEL_HINT_MS).affordances).toEqual(['cancel']);
  });

  it('re-arms the hints when a tool call takes over', () => {
    const { effects } = drive(REACH.acting);
    expect(has(effects, { kind: 'schedule', id: 'elapsed-hint' })).toBe(true);
    expect(has(effects, { kind: 'schedule', id: 'cancel-hint' })).toBe(true);
  });

  it('ignores a timer whose phase has moved on', () => {
    const { effects } = drive([...REACH.processing, timer('silence-nudge', 600)]);
    expect(effects).toEqual([]);
  });

  it('tracks what is pending so the runtime can cancel it', () => {
    const { state } = drive(REACH.processing);
    expect(state.pending.map((t) => t.id).sort()).toEqual(['cancel-hint', 'elapsed-hint']);
  });

  it('leaves hide-hold to the window controller', () => {
    const { state } = drive(REACH.listening);
    expect(state.pending.some((t) => t.id === 'hide-hold')).toBe(false);
  });
});

describe('reduce — tools', () => {
  it('promotes a tool call to Acting and returns to Processing when it ends', () => {
    const acting = drive(REACH.acting);
    expect(acting.state.phase).toEqual({ kind: 'acting', verb: 'reading' });

    const ended = drive([[{ kind: 'tool', event: 'ended', verb: 'reading' }, 1_500]], acting.state);
    expect(ended.state.phase).toEqual({ kind: 'processing', startedAt: 1_500 });
  });

  it('never promotes one while a consent prompt is on screen', () => {
    const { state } = drive([
      ...REACH.confirming,
      [{ kind: 'tool', event: 'started', verb: 'reading' }, 700],
    ]);
    expect(state.phase.kind).toBe('confirming');
  });
});

describe('reduce — settings', () => {
  it('takes a new environment and re-projects', () => {
    const env = { ...ENV, captionsEnabled: true };
    const { state, effects } = drive([[{ kind: 'settings', env }, 100]]);
    expect(state.env).toBe(env);
    expect(has(effects, { kind: 'project' })).toBe(true);
  });
});

describe('reduce — revisions', () => {
  it('advances exactly once per projected model', () => {
    let state = initial(ENV, 0);
    let projections = 0;
    for (const [input, now] of [down(0), audio(10), up(500)]) {
      const transition = reduce(state, input, now);
      state = transition.state;
      projections += transition.effects.filter((e) => e.kind === 'project').length;
    }
    expect(state.revision).toBe(projections);
  });
});

// --- projections ------------------------------------------------------------------------------

const VISIBLE_STATES: readonly ChipState[] = [
  'armed',
  'listening',
  'processing',
  'acting',
  'confirming',
  'speaking',
  'error',
  'muted',
];

describe('projectChip — colour is never the only channel', () => {
  it('gives every visible state a distinct glyph', () => {
    const glyphs = VISIBLE_STATES.map((s) => GLYPHS[s]);
    expect(new Set(glyphs).size).toBe(VISIBLE_STATES.length);
  });

  it('gives every visible state a distinct glyph-and-motion pair', () => {
    const pairs = VISIBLE_STATES.map((s) => `${GLYPHS[s]}/${MOTIONS[s]}`);
    expect(new Set(pairs).size).toBe(VISIBLE_STATES.length);
  });

  it('shares an accent between states that the spec says look alike', () => {
    // Armed and Listening are both cyan, Processing and Acting both violet (ui-design.md §4.2).
    // This is why the two assertions above exist, and it is asserted rather than assumed.
    expect(ACCENTS.armed).toBe(ACCENTS.listening);
    expect(ACCENTS.processing).toBe(ACCENTS.acting);
  });

  it('never lands on an unnamed token', () => {
    for (const state of VISIBLE_STATES) {
      expect(GLYPHS[state]).toBeTruthy();
      expect(ACCENTS[state]).toBeTruthy();
      expect(MOTIONS[state]).toBeTruthy();
    }
  });
});

describe('projectChip — states', () => {
  it('is hidden at rest and muted at rest while muted', () => {
    expect(chipStateOf(initial(ENV, 0))).toBe('hidden');
    const { state } = drive([[{ kind: 'mute', muted: true }, 0]]);
    expect(chipStateOf(state)).toBe('muted');
  });

  it('reports entering, then settled, then leaving', () => {
    const armed = drive([down(0)]).state;
    expect(projectChip(armed, 0).phase).toBe('entering');
    expect(projectChip(armed, 500).phase).toBe('settled');

    const idle = initial(ENV, 0);
    expect(projectChip(idle, 0).phase).toBe('leaving');
  });

  it('carries the latched flag so the two capture modes are never confused', () => {
    expect(projectChip(drive([tap(0)]).state, 0).latched).toBe(true);
    expect(projectChip(drive([down(0)]).state, 0).latched).toBe(false);
  });

  it('renders a verb while Acting and a question while Confirming', () => {
    expect(projectChip(drive(REACH.acting).state, 600).text?.primary).toBe('reading screen…');
    expect(projectChip(drive(REACH.confirming).state, 600).text).toEqual({
      primary: 'Look at your screen?',
      hint: '[Y] yes   [N] no',
    });
  });

  it('offers Fix only on a fault that will not clear itself', () => {
    expect(
      projectChip(drive([[{ kind: 'fault', fault: MIC_DENIED }, 0]]).state, 0).affordances,
    ).toEqual(['fix']);
    expect(
      projectChip(drive([[{ kind: 'fault', fault: OFFLINE }, 0]]).state, 0).affordances,
    ).toEqual([]);
  });

  it('holds no conversation state', () => {
    const env = { ...ENV, captionsEnabled: true };
    const { state } = drive([[{ kind: 'settings', env }, 0]]);
    expect(projectChip(state, 0).captions).toBeNull();
  });
});

describe('projectTray', () => {
  it('collapses nine states to four', () => {
    expect(projectTray(initial(ENV, 0))).toBe('idle');
    expect(projectTray(drive(REACH.listening).state)).toBe('active');
    expect(projectTray(drive([[{ kind: 'mute', muted: true }, 0]]).state)).toBe('muted');
    expect(projectTray(drive([[{ kind: 'fault', fault: MIC_DENIED }, 0]]).state)).toBe('attention');
  });

  it('puts attention above muted — a revoked mic still needs fixing', () => {
    const { state } = drive([
      [{ kind: 'mute', muted: true }, 0],
      [{ kind: 'fault', fault: MIC_DENIED }, 100],
    ]);
    expect(projectTray(state)).toBe('attention');
  });

  it('does not raise attention for a fault that clears itself', () => {
    expect(projectTray(drive([[{ kind: 'fault', fault: OFFLINE }, 0]]).state)).toBe('active');
  });
});

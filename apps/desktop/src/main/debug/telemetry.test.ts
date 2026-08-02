/**
 * The telemetry decorator, and the one claim it exists to keep.
 *
 * debug-inspector.md §4 lists four properties that make the inspector safe to leave wired in, and
 * three of them name a test. The fourth — *"the telemetry decorator never swallows an event"* —
 * named only the shape of the code, which is the weakest form of the guarantee: every arm is
 * hand-written, and an arm that mirrors a fault into the hub but forgets its `delegate.` line is
 * both invisible to review and invisible to the type checker. `ShellTelemetry` is what
 * `packages/telemetry` will implement, so an arm that drops its delegate is a log line that goes
 * missing on the day the real sink lands and not before.
 *
 * So the first test walks **every** member of the interface reflectively rather than naming the
 * ones somebody remembered. `nullTelemetry()` is the key list, which makes the check total by
 * construction: a method added to `ShellTelemetry` must be added there too for the app to compile,
 * and the moment it is, it is covered here.
 *
 * The hub is the real one. It is pure, a frame is the only way anything it holds is observable, and
 * asserting on frames rather than on a spy's call log is what keeps these tests honest about what
 * actually reaches the window.
 */

import { describe, expect, it } from 'vitest';

import type { DebugFrame } from '../../shared/debug.js';
import type { ShellTelemetry } from '../shell/telemetry.js';
import { nullTelemetry } from '../shell/telemetry.js';
import type { DebugHub } from './contracts.js';
import { createDebugHub } from './hub.js';
import { withDebugTelemetry } from './telemetry.js';

const NOW = 10_000;

/**
 * One valid call per member of `ShellTelemetry`.
 *
 * Typed against `keyof ShellTelemetry` so this table cannot fall behind the interface: adding a
 * method without adding a row here fails the build, which is the point — a new fault-shaped event
 * that nobody mirrors should be a decision somebody makes, not an omission.
 */
const CALLS: Record<keyof ShellTelemetry, readonly unknown[]> = {
  sourceStarted: ['gsi'],
  sourceRestarted: ['gsi', 2, 500],
  sourceGaveUp: ['log', 'the file stopped existing'],
  worldReset: ['match_ended'],
  matchStarted: ['match-1'],
  matchEnded: ['match-1'],
  degraded: ['full', 'gsi_only', 'the sidecar stopped answering'],
  transition: ['idle', 'armed', 1_000],
  visibilityLatency: [42],
  rendererFault: ['the overlay renderer crashed'],
  coachingTurn: ['ult_ready', 0.8, true],
  suppressed: ['kind_cooldown', 'rune_soon'],
  emptyBrief: ['ult_ready'],
  wouldSpeak: ['turn-1', 'trigger', 120],
  sidecarStderr: ['thread panicked at capture.rs:88'],
  sidecarReady: ['pipewire', true],
  sidecarProblem: ['permission_denied', true, 'Grant Screen Recording'],
  sidecarProtocolMismatch: [3, 2],
  hotkeyUnavailable: ['Control+`', false],
  pushToTalkUnavailable: [],
  sessionOpenFailed: ['the Realtime API rejected the key'],
  coachMode: ['llm'],
  coachUnavailable: ['no API key'],
  consulted: [12, 3],
  spoke: ['gank_risk', 0.7, 84],
  declined: ['nothing worth interrupting for'],
  skipped: ['in_flight'],
  modelFailed: ['429 from the model endpoint'],
};

const METHODS = Object.keys(CALLS) as (keyof ShellTelemetry)[];

interface Recorded {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A delegate built from the interface's own key list rather than from a hand-written double. */
function recordingDelegate(): { sink: ShellTelemetry; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const sink = Object.fromEntries(
    Object.keys(nullTelemetry()).map((method) => [
      method,
      (...args: unknown[]): void => {
        calls.push({ method, args });
      },
    ]),
  ) as unknown as ShellTelemetry;
  return { sink, calls };
}

/** Invoke a member by name. The table's arguments are `unknown[]`; the sink is not. */
function invoke(
  sink: ShellTelemetry,
  method: keyof ShellTelemetry,
  args: readonly unknown[],
): void {
  const fn = (sink as unknown as Record<string, (...a: unknown[]) => void>)[method];
  if (fn === undefined) throw new Error(`no such telemetry member: ${method}`);
  fn(...args);
}

function wrapped(hub: DebugHub = createDebugHub()): {
  sink: ShellTelemetry;
  calls: Recorded[];
  hub: DebugHub;
} {
  const { sink: delegate, calls } = recordingDelegate();
  return { sink: withDebugTelemetry({ hub, delegate, now: () => NOW }), calls, hub };
}

function problemsOf(hub: DebugHub): DebugFrame['problems'] {
  return hub.frame(NOW).problems;
}

describe('withDebugTelemetry', () => {
  it('covers every member of ShellTelemetry', () => {
    // `nullTelemetry()` is the app's own enumeration of the interface. If this ever fails, the
    // table above is stale and every other test in this file is quietly checking less than it says.
    expect(METHODS.sort()).toEqual(Object.keys(nullTelemetry()).sort());
  });

  it('forwards every member to the delegate, exactly once, with its arguments', () => {
    for (const method of METHODS) {
      const { sink, calls } = wrapped();
      invoke(sink, method, CALLS[method]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe(method);
      expect(calls[0]?.args).toEqual(CALLS[method]);
    }
  });

  it('calls the delegate even when the hub throws', () => {
    // The delegate is called first and unconditionally, so a hub that fails cannot cost a telemetry
    // event. This is the ordering the decorator's contract rests on, and it is invisible otherwise.
    const broken: DebugHub = {
      ...createDebugHub(),
      recordProblem: (): never => {
        throw new Error('hub is broken');
      },
    };
    const { sink, calls } = wrapped(broken);

    expect(() => {
      invoke(sink, 'rendererFault', CALLS.rendererFault);
    }).toThrow('hub is broken');
    expect(calls).toHaveLength(1);
  });

  it('mirrors the fault-shaped members as problems, with their origin', () => {
    const expected: Partial<Record<keyof ShellTelemetry, string>> = {
      sourceRestarted: 'source',
      sourceGaveUp: 'source',
      worldReset: 'world',
      degraded: 'degradation',
      rendererFault: 'renderer',
      emptyBrief: 'coach',
      sidecarStderr: 'sidecar',
      sidecarProblem: 'sidecar',
      sidecarProtocolMismatch: 'sidecar',
      hotkeyUnavailable: 'hotkey',
      pushToTalkUnavailable: 'hotkey',
      coachUnavailable: 'coach',
      modelFailed: 'coach',
    };

    for (const [method, origin] of Object.entries(expected)) {
      const { sink, hub } = wrapped();
      invoke(sink, method as keyof ShellTelemetry, CALLS[method as keyof ShellTelemetry]);

      const problems = problemsOf(hub);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.origin).toBe(origin);
      expect(problems[0]?.at).toBe(NOW);
      expect(problems[0]?.message.length).toBeGreaterThan(0);
    }
  });

  it('raises no problem for the members that are routine rather than faults', () => {
    // Not "not mirrored" — `declined` and `skipped` *are* mirrored, as Triggers rows. What is
    // asserted here is narrower and is the thing that matters: none of these reaches the Problems
    // panel. Declining is the correct and overwhelmingly common outcome for either coach, and a
    // panel that filled with routine silence would be a panel nobody reads the real faults out of.
    //
    // `suppressed` and `coachingTurn` are the deterministic coach's equivalents, and they are not
    // mirrored at all: they fire on every version bump and the policy decorator already has both in
    // far more detail — §"What is mirrored, and what is not".
    const silent: (keyof ShellTelemetry)[] = [
      'sourceStarted',
      'matchStarted',
      'matchEnded',
      'transition',
      'visibilityLatency',
      'coachingTurn',
      'suppressed',
      'wouldSpeak',
      'coachMode',
      'consulted',
      'spoke',
      'declined',
      'skipped',
    ];

    for (const method of silent) {
      const { sink, hub } = wrapped();
      invoke(sink, method, CALLS[method]);
      expect(problemsOf(hub)).toHaveLength(0);
    }
  });

  it('reports a sidecar that handshook without a capture backend, and stays quiet when it has one', () => {
    const ready = wrapped();
    invoke(ready.sink, 'sidecarReady', ['pipewire', true]);
    expect(problemsOf(ready.hub)).toHaveLength(0);

    const blind = wrapped();
    invoke(blind.sink, 'sidecarReady', ['pipewire', false]);
    const problems = problemsOf(blind.hub);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.origin).toBe('sidecar');
    expect(problems[0]?.message).toContain('pipewire');
  });

  it('counts an empty brief as well as reporting it', () => {
    // The one signal the gate ladder cannot show: the trigger was admitted and the brief came back
    // empty, so the turn was dropped after the point every other panel stops watching.
    const { sink, hub } = wrapped();
    invoke(sink, 'emptyBrief', ['ult_ready']);
    invoke(sink, 'emptyBrief', ['rune_soon']);

    expect(hub.frame(NOW).counters.emptyBriefs).toBe(2);
    expect(problemsOf(hub)).toHaveLength(2);
  });

  it('routes the LLM coach\u2019s declines into the Triggers panel, not into Problems', () => {
    const { sink, hub } = wrapped();
    invoke(sink, 'declined', ['nothing worth interrupting for right now']);
    invoke(sink, 'skipped', ['in_flight']);

    const frame = hub.frame(NOW);
    // Declining is the correct and overwhelmingly common outcome for either coach, so it belongs
    // beside the deterministic coach's refusals rather than among the faults. Under `llm` this is
    // the *only* account of a moment the coach passed on — there is no gate ladder to read.
    expect(frame.ticks).toHaveLength(2);
    expect(frame.ticks.map((each) => each.decision)).toEqual([
      { speak: false, reason: 'nothing worth interrupting for right now', key: null },
      // Kept distinct: the coach was not consulted at all, which is a different answer to "why was
      // it quiet" from "it looked and decided not to".
      { speak: false, reason: 'skipped: in_flight', key: null },
    ]);
    expect(problemsOf(hub)).toHaveLength(0);
  });

  it('names the offending event in the messages that have one', () => {
    const { sink, hub } = wrapped();
    invoke(sink, 'sidecarProblem', ['permission_denied', true, 'Grant Screen Recording']);

    const message = problemsOf(hub)[0]?.message ?? '';
    expect(message).toContain('permission_denied');
    expect(message).toContain('fatal');
    expect(message).toContain('Grant Screen Recording');
  });
});

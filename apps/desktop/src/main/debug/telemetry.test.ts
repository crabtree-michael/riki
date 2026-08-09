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
  playerTurn: ['turn-1', 280],
  emptySnapshot: ['turn-1'],
  snapshotOmitted: ['turn-1', ['map']],
  wouldSpeak: ['turn-1', 120],
  sidecarStderr: ['thread panicked at capture.rs:88'],
  sidecarReady: ['pipewire', true],
  sidecarProblem: ['permission_denied', true, 'Grant Screen Recording'],
  sidecarProtocolMismatch: [3, 2],
  hotkeyUnavailable: ['Control+`', false],
  pushToTalkUnavailable: [],
  sessionOpenFailed: ['the Realtime API rejected the key'],
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
      emptySnapshot: 'world',
      sessionOpenFailed: 'renderer',
      sidecarStderr: 'sidecar',
      sidecarProblem: 'sidecar',
      sidecarProtocolMismatch: 'sidecar',
      hotkeyUnavailable: 'hotkey',
      pushToTalkUnavailable: 'hotkey',
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
    // `playerTurn` and `snapshotOmitted` are the ones that matter here: they fire on every turn and
    // the snapshot decorator already has both in far more detail, so a Problems panel that filled
    // with them would be a panel nobody reads the real faults out of — §"What is mirrored, and what
    // is not".
    const silent: (keyof ShellTelemetry)[] = [
      'sourceStarted',
      'matchStarted',
      'matchEnded',
      'transition',
      'visibilityLatency',
      'playerTurn',
      'snapshotOmitted',
      'wouldSpeak',
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

  it('reports an empty snapshot, which is the one thing a full Turns panel cannot show', () => {
    // A turn row with a plausible-looking snapshot in it and a turn row with an empty one look the
    // same at a glance, and the second means the model is about to answer a question about a game
    // it cannot see.
    const { sink, hub } = wrapped();
    invoke(sink, 'emptySnapshot', ['turn-1']);

    const problems = problemsOf(hub);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.origin).toBe('world');
    expect(problems[0]?.message).toContain('turn-1');
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

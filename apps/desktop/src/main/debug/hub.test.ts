/**
 * The hub: what it keeps, what it drops, and what it refuses to carry.
 *
 * The last of those is the one worth having a test for. `shared/debug.ts` promises that the
 * player's transcript never reaches a frame, and a promise in a header is a promise until somebody
 * adds a field.
 */

import { describe, expect, it } from 'vitest';

import { DEBUG_LIMITS } from '../../shared/debug.js';
import type { DebugTurnOpenedInput } from './contracts.js';
import { createDebugHub, toCounts } from './hub.js';

// -------------------------------------------------------------------------------------------

function turn(overrides: Partial<DebugTurnOpenedInput> = {}): DebugTurnOpenedInput {
  return {
    turnId: 'voice_1',
    at: 1_000,
    clock: 600,
    cause: 'player',
    snapshotText: 'clock 10:00',
    snapshotTokens: 42,
    snapshotOmitted: [],
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------

describe('an empty hub', () => {
  it('produces a frame that says nothing is wired rather than inventing zeroes', () => {
    const frame = createDebugHub().frame(500);

    expect(frame.session.matchId).toBeNull();
    expect(frame.session.matchSession).toBe(false);
    expect(frame.session.health.summary).toBe('no state subsystem');
    expect(frame.turns).toEqual([]);
    expect(frame.trace).toEqual([]);
  });

  it('advances the revision every frame, so the renderer can drop a stale one', () => {
    const hub = createDebugHub();
    expect(hub.frame(0).revision).toBe(1);
    expect(hub.frame(1).revision).toBe(2);
  });
});

describe('turns', () => {
  it('carries the snapshot as rendered, and what was left out of it', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn({ snapshotOmitted: ['map', 'derived'] }));

    const [held] = hub.frame(0).turns;
    // The one place in the process where the live text can be read at all: the golden corpus
    // renders it for a fixture, and nothing else keeps it.
    expect(held?.snapshotText).toBe('clock 10:00');
    expect(held?.snapshotOmitted).toEqual(['map', 'derived']);
    expect(held?.outcome).toBe('open');
  });

  it('joins the close and the transcript to the turn that was opened', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());
    hub.recordTurnClosed('voice_1', 'spoke', 2_400);
    hub.recordAgentTranscript('voice_1', 'Your ult is up.');

    const [held] = hub.frame(0).turns;
    expect(held?.outcome).toBe('spoke');
    expect(held?.agentSaid).toBe('Your ult is up.');
    // The question-to-answer leg spans two events, so the close has to carry its own timestamp —
    // the hub has no clock and a frame is a snapshot of neither end.
    expect(held?.closedAt).toBe(2_400);
  });

  it('never carries the player transcript, only its length', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn({ turnId: 'turn_1' }));
    hub.recordPlayerTranscript('turn_1', 'should I buy a bkb'.length);

    const [held] = hub.frame(0).turns;
    expect(held?.playerSaidChars).toBe(18);
    // The frame has nowhere to put it, which is the point: the header's promise is structural.
    expect(JSON.stringify(held)).not.toContain('bkb');
  });

  it('ignores a transcript for a turn it never saw open', () => {
    const hub = createDebugHub();
    hub.recordAgentTranscript('voice_99', 'from a match that ended');
    hub.recordTurnClosed('voice_99', 'spoke', 2_400);
    expect(hub.frame(0).turns).toEqual([]);
  });

  it('starts a turn with no calls and no close, rather than with plausible zeroes', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());

    const [held] = hub.frame(0).turns;
    // An open turn that has called nothing *yet* and a spoken turn that called nothing are the same
    // shape here and different findings on screen, which is `view.ts`' problem rather than this one.
    expect(held?.tools).toEqual([]);
    expect(held?.toolsDropped).toBe(0);
    expect(held?.closedAt).toBeNull();
  });

  it('clips long text rather than letting one turn fill the window', () => {
    const hub = createDebugHub();
    const long = 'x'.repeat(DEBUG_LIMITS.textChars + 500);
    hub.recordTurnOpened(turn({ snapshotText: long }));

    const text = hub.frame(0).turns[0]?.snapshotText ?? '';
    expect(text.length).toBeLessThan(long.length);
    // Marked, not silently cut: a snapshot that ends mid-line and one that *was rendered* mid-line
    // look identical otherwise, and the second is a real failure.
    expect(text).toContain('more characters');
  });

  it('drops the index entry when a turn falls out of the buffer', () => {
    const hub = createDebugHub();
    for (let i = 0; i < DEBUG_LIMITS.turns + 5; i += 1) {
      hub.recordTurnOpened(turn({ turnId: `voice_${String(i)}` }));
    }
    // The first turn is long gone, so a late transcript for it must not be retained anywhere.
    hub.recordAgentTranscript('voice_0', 'too late');

    const frame = hub.frame(0);
    expect(frame.turns).toHaveLength(DEBUG_LIMITS.turns);
    expect(JSON.stringify(frame)).not.toContain('too late');
  });
});

describe('tool calls (ADR-0047)', () => {
  it('attributes a call to the turn that was open, without being told which', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn({ turnId: 'voice_1', at: 1_000 }));
    hub.recordTurnOpened(turn({ turnId: 'voice_2', at: 5_000 }));

    const seq = hub.recordToolCall({ name: 'enemy', args: '{"hero":"puck"}', at: 5_120 });
    hub.recordToolResult(seq, { status: 'ok', result: '{"heroes":[]}', at: 5_138 });

    const [first, second] = hub.frame(6_000).turns;
    // `ToolDispatcher.call` is `(name, args)` and carries no turn id. Widening it so the inspector
    // could read one would make `packages/realtime` aware of a debug window (ADR-0032).
    expect(first?.tools).toEqual([]);
    expect(second?.tools).toHaveLength(1);
    expect(second?.tools[0]?.name).toBe('enemy');
    expect(second?.tools[0]?.args).toBe('{"hero":"puck"}');
    expect(second?.tools[0]?.result).toBe('{"heroes":[]}');
    expect(second?.tools[0]?.durationMs).toBe(18);
  });

  it('shows a call with no result yet as pending rather than as nothing', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());
    hub.recordToolCall({ name: 'my_state', args: '{}', at: 1_100 });

    const [call] = hub.frame(1_200).turns[0]?.tools ?? [];
    // A dispatcher that hangs is the failure worth seeing, and a row that appeared only once a
    // result landed would render a hang as nothing at all.
    expect(call?.status).toBe('pending');
    expect(call?.result).toBeNull();
    expect(call?.durationMs).toBeNull();
  });

  it('keeps a tool that answered `unknown` apart from one that failed', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());

    const unknown = hub.recordToolCall({ name: 'world_at', args: '{"clock":120}', at: 1_100 });
    hub.recordToolResult(unknown, {
      status: 'unknown',
      result: '{"unknown":"never observed this match"}',
      at: 1_105,
    });
    const failed = hub.recordToolCall({ name: 'economy', args: '{}', at: 1_200 });
    hub.recordToolResult(failed, { status: 'failed', result: 'Error: no scoreboard', at: 1_210 });

    const calls = hub.frame(1_300).turns[0]?.tools ?? [];
    // An honest "nobody observed this" is an answer (ADR-0043); a throw is ours. Collapsing them
    // would make a vague answer and a broken tool the same row.
    expect(calls.map((call) => call.status)).toEqual(['unknown', 'failed']);
  });

  it('records a call that arrived with no turn open, rather than dropping it', () => {
    const hub = createDebugHub();
    hub.recordToolCall({ name: 'my_state', args: '{}', at: 900 });

    const frame = hub.frame(1_000);
    expect(frame.turns).toEqual([]);
    // Every turn has a key press behind it (ADR-0042), so this means the session answered something
    // nobody asked — and it is invisible everywhere else in the process.
    expect(frame.problems[0]?.origin).toBe('inspector');
    expect(frame.problems[0]?.message).toContain('my_state');
  });

  it('counts the calls the per-turn cap dropped, so a truncated list says it is one', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());
    for (let i = 0; i < DEBUG_LIMITS.toolCallsPerTurn + 3; i += 1) {
      hub.recordToolCall({ name: `call_${String(i)}`, args: '{}', at: 1_000 + i });
    }

    const [held] = hub.frame(2_000).turns;
    expect(held?.tools).toHaveLength(DEBUG_LIMITS.toolCallsPerTurn);
    expect(held?.toolsDropped).toBe(3);
    // Oldest dropped, newest kept: the last thing it asked for is the thing you are looking at.
    expect(held?.tools[0]?.name).toBe('call_3');
  });

  it('clips arguments and results, which are the only unbounded thing a call carries', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());
    const seq = hub.recordToolCall({
      name: 'enemy',
      args: 'a'.repeat(DEBUG_LIMITS.toolArgsChars + 100),
      at: 1_000,
    });
    hub.recordToolResult(seq, {
      status: 'ok',
      result: 'b'.repeat(DEBUG_LIMITS.toolResultChars + 100),
      at: 1_010,
    });

    const [call] = hub.frame(2_000).turns[0]?.tools ?? [];
    expect(call?.args).toContain('more characters');
    expect(call?.result).toContain('more characters');
  });

  it('drops a result whose call has fallen out of the buffer', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn({ turnId: 'voice_0' }));
    const seq = hub.recordToolCall({ name: 'my_state', args: '{}', at: 1_000 });

    for (let i = 1; i <= DEBUG_LIMITS.turns; i += 1) {
      hub.recordTurnOpened(turn({ turnId: `voice_${String(i)}` }));
    }
    hub.recordToolResult(seq, { status: 'ok', result: 'too late', at: 9_000 });

    // The call index must not outlive the ring buffer, or a long match leaks an entry per call.
    expect(JSON.stringify(hub.frame(9_100))).not.toContain('too late');
  });
});

describe('the trace', () => {
  it('is bounded, and keeps the newest', () => {
    const hub = createDebugHub();
    for (let i = 0; i < DEBUG_LIMITS.trace + 20; i += 1) {
      hub.recordTrace('turn', `step ${String(i)}`, i);
    }

    const trace = hub.frame(0).trace;
    expect(trace).toHaveLength(DEBUG_LIMITS.trace);
    expect(trace[trace.length - 1]?.seq).toBe(DEBUG_LIMITS.trace + 20);
  });

  it('stamps a step inside a run with how long after the run began it happened', () => {
    const hub = createDebugHub();
    hub.recordTrace('turn', 'before', 100);
    hub.markTraceRun(1_000);
    hub.recordTrace('scenario', 'during', 1_250);
    hub.markTraceRun(null);
    hub.recordTrace('turn', 'after', 2_000);

    const [before, during, after] = hub.frame(0).trace;
    // A wall-clock time answers "when"; this answers "how long after the trigger", which is the
    // question a chain that stalls actually poses.
    expect(before?.sinceRunMs).toBeNull();
    expect(during?.sinceRunMs).toBe(250);
    expect(after?.sinceRunMs).toBeNull();
  });
});

describe('problems and the match boundary', () => {
  it('keeps problems and the trace across a match reset, and drops everything else', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());
    hub.recordTrace('scenario', 'synthetic match finished', 950);
    hub.recordProblem('sidecar', 'thread panicked', 900);

    hub.resetMatch();
    const frame = hub.frame(1_000);

    expect(frame.turns).toEqual([]);
    // A sidecar that panicked during the last match is exactly what somebody is still reading when
    // the next one starts — and a scenario that *ended* the match must not erase its own trace.
    expect(frame.problems).toEqual([{ at: 900, origin: 'sidecar', message: 'thread panicked' }]);
    expect(frame.trace).toHaveLength(1);
  });
});

describe('pulled sources', () => {
  it('reads the session, the world and the actions at frame time', () => {
    const hub = createDebugHub();
    hub.observe({
      session: () => ({
        matchId: '789',
        matchSession: true,
        chipPhase: 'idle',
        chipVisible: false,
        muted: false,
        healthLevel: 'gsi_only',
        healthSummary: 'GSI only',
        sources: [{ id: 'gsi', state: 'live', reason: null, lastObservationAt: 800, restarts: 0 }],
        bus: { depth: 0, dropped: [], gaps: [] },
      }),
      world: (now) => ({
        version: 12,
        clock: 620,
        paused: false,
        facts: [
          {
            path: 'self.gold',
            value: '{"reliable":100,"unreliable":900}',
            source: 'gsi',
            confidence: 1,
            staleness: 'fresh',
            ageMs: now - 900,
            ageBasis: 'game',
          },
        ],
        enemies: [],
        derived: [],
      }),
      actions: () => [
        {
          id: 'scenario.speak',
          group: 'Scenarios',
          label: 'Speak now',
          note: 'sends one turn',
          running: false,
          lastOutcome: null,
        },
      ],
    });

    const frame = hub.frame(1_000);
    expect(frame.session.matchId).toBe('789');
    expect(frame.session.matchSession).toBe(true);
    expect(frame.actions).toHaveLength(1);
    expect(frame.world.facts[0]?.ageMs).toBe(100);
    // Ages are computed against the frame's `now`, not stored — a stored age is already wrong.
    expect(frame.session.health.sources[0]?.lastObservationAgoMs).toBe(200);
  });

  it('reports a version rate, so a source that went quiet is visible without waiting', () => {
    const hub = createDebugHub();
    let version = 0;
    hub.observe({
      world: () => ({
        version,
        clock: null,
        paused: false,
        facts: [],
        enemies: [],
        derived: [],
      }),
    });

    hub.frame(0);
    version = 8;
    expect(hub.frame(1_000).world.versionsPerSecond).toBe(8);

    // And it decays rather than latching: a GSI client that stopped POSTing shows as a rate falling
    // toward zero, which is the signal a static `version` number cannot give.
    expect(hub.frame(4_000).world.versionsPerSecond).toBeLessThan(8);
  });
});

describe('toCounts', () => {
  it('sorts by count and then by key, so the display does not jitter', () => {
    expect(
      toCounts([
        ['b', 1],
        ['a', 5],
        ['c', 1],
      ]),
    ).toEqual([
      { key: 'a', count: 5 },
      { key: 'b', count: 1 },
      { key: 'c', count: 1 },
    ]);
  });
});

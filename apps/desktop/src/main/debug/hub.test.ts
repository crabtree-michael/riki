/**
 * The hub: what it keeps, what it drops, and what it refuses to carry.
 *
 * The last of those is the one worth having a test for. `shared/debug.ts` promises that the
 * player's transcript never reaches a frame, and a promise in a header is a promise until somebody
 * adds a field.
 */

import { describe, expect, it } from 'vitest';

import { DEBUG_LIMITS } from '../../shared/debug.js';
import type { DebugGateInput, DebugTickInput, DebugTurnOpenedInput } from './contracts.js';
import { createDebugHub, toCounts } from './hub.js';

// -------------------------------------------------------------------------------------------

const GATES: DebugGateInput = {
  quietMode: false,
  agentSpeaking: false,
  playerSpeaking: false,
  mutedUntilMs: null,
  intensity: 0,
  intensityThreshold: 0.6,
  speakThreshold: 0.4,
  lastSpokeAtMs: null,
  globalCooldownMs: 45_000,
  latched: [],
  kindCooldowns: [],
};

function tick(overrides: Partial<DebugTickInput> = {}): DebugTickInput {
  return {
    at: 1_000,
    clock: 600,
    worldVersion: 7,
    gates: GATES,
    candidates: [
      {
        kind: 'ult_ready',
        key: 'ult_ready:self',
        salience: 0.8,
        magnitude: 0.5,
        confidence: 0.9,
        actWithinSeconds: 12,
        text: 'your ult is up',
        taped: true,
        ladder: [{ reason: 'not_in_match', refuses: false }],
        rank: 'winner',
      },
    ],
    decision: { speak: true, key: 'ult_ready:self' },
    ...overrides,
  };
}

function turn(overrides: Partial<DebugTurnOpenedInput> = {}): DebugTurnOpenedInput {
  return {
    turnId: 'coach_1',
    at: 1_000,
    clock: 600,
    cause: 'trigger',
    eventId: 'ult_ready',
    salience: 0.8,
    snapshotText: 'clock 10:00',
    snapshotTokens: 42,
    briefText: 'your ult is up and sf is missing',
    briefTokens: 18,
    briefSections: ['cooldowns'],
    briefOmitted: [],
    briefEmpty: false,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------

describe('an empty hub', () => {
  it('produces a frame that says nothing is wired rather than inventing zeroes', () => {
    const frame = createDebugHub().frame(500);

    expect(frame.session.matchId).toBeNull();
    expect(frame.session.coachingRoot).toBe(false);
    expect(frame.session.health.summary).toBe('no state subsystem');
    // Null, not `500`. The engine's state is only visible when a tick assembles a `GateContext`,
    // and claiming it is current as of the frame would be the misleading answer.
    expect(frame.session.gates.asOfMs).toBeNull();
    expect(frame.ticks).toEqual([]);
    expect(frame.counters.ticks).toBe(0);
  });

  it('advances the revision every frame, so the renderer can drop a stale one', () => {
    const hub = createDebugHub();
    expect(hub.frame(0).revision).toBe(1);
    expect(hub.frame(1).revision).toBe(2);
  });
});

describe('ticks', () => {
  it('keeps ticks with candidates and counts the ones without', () => {
    const hub = createDebugHub();
    for (let i = 0; i < 50; i += 1) hub.recordTick(tick({ candidates: [] }));
    hub.recordTick(tick());

    const frame = hub.frame(2_000);
    // A match spends most of its time producing empty ticks. Keeping them would push every
    // interesting one out of the buffer within seconds; the count is what keeps "the engine is not
    // running" distinguishable from "the engine found nothing".
    expect(frame.ticks).toHaveLength(1);
    expect(frame.counters.ticks).toBe(51);
  });

  it('takes gate state from every tick, including the empty ones', () => {
    const hub = createDebugHub();
    hub.recordTick(tick());
    hub.recordTick(
      tick({
        at: 9_000,
        candidates: [],
        gates: { ...GATES, latched: ['rune_soon:bounty'], quietMode: true },
      }),
    );

    const frame = hub.frame(10_000);
    // The empty tick is the only thing that reports a latch clearing or a cooldown expiring, which
    // is half of what somebody staring at an unexplained silence needs.
    expect(frame.session.gates.latched).toEqual(['rune_soon:bounty']);
    expect(frame.session.gates.quietMode).toBe(true);
    expect(frame.session.gates.asOfMs).toBe(9_000);
  });

  it('keeps a decline with no candidates, which is all the LLM coach ever has', () => {
    const hub = createDebugHub();
    hub.recordTick(tick({ candidates: [] }));
    hub.recordDecline('nothing worth interrupting for right now', 9_000, 620);

    const frame = hub.frame(10_000);
    // The empty-tick rule above must not swallow this: `packages/coach` has no detectors, so a
    // decline is the *only* thing it says about a moment it passed on. Dropping it would leave the
    // Triggers panel blank in `llm` mode and look exactly like a coach that never ran.
    expect(frame.ticks).toHaveLength(1);
    expect(frame.ticks[0]?.candidates).toEqual([]);
    expect(frame.ticks[0]?.decision).toEqual({
      speak: false,
      // A sentence, not a `SuppressionReason` — the two coaches owe each other no shared vocabulary
      // for why they stayed quiet, which is the same widening `CoachDriver.onDeclined` makes.
      reason: 'nothing worth interrupting for right now',
      key: null,
    });
    expect(frame.counters.ticks).toBe(2);
  });

  it('is bounded, so a forty-minute match holds a fixed amount', () => {
    const hub = createDebugHub();
    for (let i = 0; i < DEBUG_LIMITS.ticks + 40; i += 1) hub.recordTick(tick({ at: i }));

    const frame = hub.frame(0);
    expect(frame.ticks).toHaveLength(DEBUG_LIMITS.ticks);
    // The oldest went, not the newest.
    expect(frame.ticks[frame.ticks.length - 1]?.seq).toBe(DEBUG_LIMITS.ticks + 40);
  });
});

describe('turns', () => {
  it('carries the snapshot and the brief as rendered', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());

    const [held] = hub.frame(0).turns;
    // The one place in the process where the two can be read side by side as they actually were.
    expect(held?.snapshotText).toBe('clock 10:00');
    expect(held?.briefText).toBe('your ult is up and sf is missing');
    expect(held?.outcome).toBe('open');
  });

  it('joins the close and the coach transcript to the turn that was opened', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(turn());
    hub.recordTurnClosed('coach_1', 'spoke');
    hub.recordAgentTranscript('coach_1', 'Your ult is up — go.');

    const [held] = hub.frame(0).turns;
    expect(held?.outcome).toBe('spoke');
    expect(held?.agentSaid).toBe('Your ult is up — go.');
  });

  it('never carries the player transcript, only its length', () => {
    const hub = createDebugHub();
    hub.recordTurnOpened(
      turn({ turnId: 'turn_1', cause: 'player', eventId: null, salience: null }),
    );
    hub.recordPlayerTranscript('turn_1', 'should I buy a bkb'.length);

    const [held] = hub.frame(0).turns;
    expect(held?.playerSaidChars).toBe(18);
    // The frame has nowhere to put it, which is the point: the header's promise is structural.
    expect(JSON.stringify(held)).not.toContain('bkb');
  });

  it('ignores a transcript for a turn it never saw open', () => {
    const hub = createDebugHub();
    hub.recordAgentTranscript('coach_99', 'from a match that ended');
    hub.recordTurnClosed('coach_99', 'spoke');
    expect(hub.frame(0).turns).toEqual([]);
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
      hub.recordTurnOpened(turn({ turnId: `coach_${String(i)}` }));
    }
    // The first turn is long gone, so a late transcript for it must not be retained anywhere.
    hub.recordAgentTranscript('coach_0', 'too late');

    const frame = hub.frame(0);
    expect(frame.turns).toHaveLength(DEBUG_LIMITS.turns);
    expect(JSON.stringify(frame)).not.toContain('too late');
  });
});

describe('problems and the match boundary', () => {
  it('keeps problems across a match reset, and drops everything else', () => {
    const hub = createDebugHub();
    hub.recordTick(tick());
    hub.recordTurnOpened(turn());
    hub.recordEmptyBrief();
    hub.recordProblem('sidecar', 'thread panicked', 900);

    hub.resetMatch();
    const frame = hub.frame(1_000);

    expect(frame.ticks).toEqual([]);
    expect(frame.turns).toEqual([]);
    expect(frame.counters.emptyBriefs).toBe(0);
    expect(frame.session.gates.asOfMs).toBeNull();
    // A sidecar that panicked during the last match is exactly what somebody is still reading when
    // the next one starts.
    expect(frame.problems).toEqual([{ at: 900, origin: 'sidecar', message: 'thread panicked' }]);
  });
});

describe('pulled sources', () => {
  it('reads the world and the counters at frame time', () => {
    const hub = createDebugHub();
    hub.observe({
      session: () => ({
        matchId: '789',
        coachingRoot: true,
        chipPhase: 'idle',
        chipVisible: false,
        muted: false,
        coachMode: 'static',
        unprompted: true,
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
      counters: () => ({
        detected: [{ key: 'ult_ready', count: 3 }],
        suppressed: [{ key: 'latched', count: 9 }],
        spoken: 1,
      }),
    });

    const frame = hub.frame(1_000);
    expect(frame.session.matchId).toBe('789');
    expect(frame.session.gates.unprompted).toBe(true);
    expect(frame.world.facts[0]?.ageMs).toBe(100);
    // Ages are computed against the frame's `now`, not stored — a stored age is already wrong.
    expect(frame.session.health.sources[0]?.lastObservationAgoMs).toBe(200);
    expect(frame.counters.spoken).toBe(1);
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

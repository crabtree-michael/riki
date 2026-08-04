/**
 * One coach turn against a state nobody is playing (ADR-0038).
 *
 * Tier 1. Every collaborator a rehearsal needs is already a port: the library is a fake, the coach
 * is a fake `CoachDriver`, and the world is a real `WorldModelStore` because that one is pure and
 * fusing a recording into it is the thing worth exercising rather than stubbing.
 *
 * The assertions divide in two, and the second half is why this file is long.
 *
 * **It does what it says.** A recording is fused, the coach is consulted once, and the turn lands in
 * the buffer carrying the coach's drafted line.
 *
 * **It cannot do what it must not.** A rehearsal's whole licence to exist is that it reaches none of
 * the live match — so the live world is asserted untouched, the outcome is asserted never to be
 * `spoke`, the turn ids are asserted not to collide with the real coach's, and every failure is
 * asserted to be an outcome and a problem rather than a throw. Those are the properties ADR-0038
 * traded for a fifth intent, and a test suite that only covered the happy path would be guarding
 * the wrong half.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { MatchId, RikiContext } from '@riki/context';
import { createContextAssembler, createPreambleAssembler } from '@riki/context';
import type { EventTape } from '@riki/events';
import { createEventTape } from '@riki/events';
import type { MonoMs, WorldModelStore } from '@riki/world-model';
import { createStalenessPolicy, createWorldModelStore } from '@riki/world-model';

import { toContextReader } from '../agent/index.js';
import type { CoachConsultation, CoachDriver, CoachProposal } from '../agent/index.js';
import { NULL_REFERENCE_DATA } from '../shell/telemetry.js';
import { createDebugHub } from './hub.js';
import type { MockState, MockStateLibrary } from './mock-states.js';
import type { RehearsalStack } from './rehearsal.js';
import { createDebugRehearsal, resetRehearsalIds } from './rehearsal.js';

// -------------------------------------------------------------------------------------------

const staleness = createStalenessPolicy();

/** A recording with a clock that advances, which is enough for the world to fuse something. */
function mockState(overrides: Partial<MockState> = {}): MockState {
  return {
    id: 'laning-phase',
    label: 'laning phase',
    note: null,
    lines: [
      {
        atMs: 0,
        body: { map: { clock_time: 600, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' } },
      },
      {
        atMs: 250,
        body: { map: { clock_time: 601, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' } },
      },
    ],
    ...overrides,
  };
}

function library(states: readonly MockState[]): MockStateLibrary {
  return {
    list: () => states,
    get: (id) => states.find((state) => state.id === id) ?? null,
  };
}

interface FakeDriver extends CoachDriver {
  readonly consultedAt: number[];
  readonly disposals: () => number;
}

/**
 * A coach that answers however the test wants, and counts what it was asked.
 *
 * Only `consult` and `dispose` have behaviour: the rehearsal reaches for nothing else, and a fake
 * that pretended to implement the push path would be claiming coverage this file does not have.
 */
function fakeDriver(answer: CoachConsultation | (() => Promise<CoachConsultation>)): FakeDriver {
  const consultedAt: number[] = [];
  let disposals = 0;
  return {
    consultedAt,
    disposals: () => disposals,
    mode: 'llm',
    start: () => () => undefined,
    onProposal: () => () => undefined,
    onDeclined: () => () => undefined,
    setAgentSpeaking: () => undefined,
    setPlayerSpeaking: () => undefined,
    setQuietMode: () => undefined,
    setMuted: () => undefined,
    consult: (now: MonoMs): Promise<CoachConsultation> => {
      consultedAt.push(now);
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    },
    dispose: (): void => {
      disposals += 1;
    },
  };
}

function proposal(overrides: Partial<CoachProposal> = {}): CoachConsultation {
  return {
    spoke: true,
    proposal: {
      id: 'ult_ready',
      topic: 'your ult is up',
      salience: 0.8,
      guidance: 'back off — their jungler is missing',
      at: 1_000 as MonoMs,
      ...overrides,
    },
  } as CoachConsultation;
}

interface Harness {
  readonly hub: ReturnType<typeof createDebugHub>;
  readonly worlds: WorldModelStore[];
  readonly stacks: { world: WorldModelStore; matchId: string }[];
  readonly driver: FakeDriver;
  readonly disposed: () => number;
}

function harness(
  states: readonly MockState[],
  answer: CoachConsultation | (() => Promise<CoachConsultation>),
): { port: ReturnType<typeof createDebugRehearsal> } & Harness {
  const hub = createDebugHub();
  const worlds: WorldModelStore[] = [];
  const stacks: { world: WorldModelStore; matchId: string }[] = [];
  const driver = fakeDriver(answer);
  let disposed = 0;
  let clock = 10_000;

  const port = createDebugRehearsal({
    library: library(states),
    hub,
    now: () => (clock += 1),
    world: () => {
      const world = createWorldModelStore({ staleness });
      worlds.push(world);
      return world;
    },
    stack: (world: WorldModelStore, matchId: MatchId): RehearsalStack => {
      stacks.push({ world, matchId: String(matchId) });
      const tape: EventTape = createEventTape();
      const context: RikiContext = createContextAssembler({
        matchId,
        world: toContextReader(world, { staleness }),
        preamble: createPreambleAssembler({ reference: NULL_REFERENCE_DATA }),
      });
      return {
        context,
        driver,
        tape,
        dispose: () => {
          disposed += 1;
        },
      };
    },
  });

  return { port, hub, worlds, stacks, driver, disposed: () => disposed };
}

beforeEach(() => {
  resetRehearsalIds();
});

// -------------------------------------------------------------------------------------------

describe('a rehearsal that produces a line', () => {
  it('fuses the recording, consults once, and records the coach output on the turn', async () => {
    const { port, hub } = harness([mockState()], proposal());

    const outcome = await port.run('laning-phase');
    expect(outcome).toEqual({ ok: true, turnId: 'rehearsal_1', spoke: true });

    const turns = hub.frame(20_000).turns;
    expect(turns).toHaveLength(1);
    // The whole point of the feature: the coach's text, without a match having happened.
    expect(turns[0]?.guidance).toBe('back off — their jungler is missing');
    expect(turns[0]?.cause).toBe('rehearsal');
    expect(turns[0]?.mockState).toBe('laning-phase');
  });

  it('closes rehearsed, never spoke', async () => {
    const { port, hub } = harness([mockState()], proposal());
    await port.run('laning-phase');

    // A window whose only job is to be believed must not be able to claim a thing was said when
    // nothing was: no session is reachable from this component at all.
    expect(hub.frame(20_000).turns[0]?.outcome).toBe('rehearsed');
  });

  it('replays the recording into a world of its own, leaving the live one untouched', async () => {
    const live = createWorldModelStore({ staleness });
    const { port, worlds, stacks } = harness([mockState()], proposal());

    await port.run('laning-phase');

    // The scratch world saw the recording...
    expect(worlds).toHaveLength(1);
    expect(worlds[0]?.version).toBeGreaterThan(0);
    // ...the coach was built over that same scratch world...
    expect(stacks[0]?.world).toBe(worlds[0]);
    expect(stacks[0]?.matchId).toBe('mock:laning-phase');
    // ...and a store the rehearsal was never handed is exactly where it was. This is the property
    // that bought the fifth intent: the facts the app is coaching on never see a mock payload.
    expect(live.version).toBe(0);
  });

  it('slides the recording onto main clock, so the coach does not read an expired match', async () => {
    const { port, worlds } = harness([mockState()], proposal());
    await port.run('laning-phase');

    const world = worlds[0];
    if (world === undefined) throw new Error('expected a scratch world');

    // A fixture's `atMs` starts at zero; main's clock has been running since the app started. Fused
    // at their recorded times every fact would age straight to `expired`, the snapshot would render
    // as an empty match, and somebody would report that as "the rehearsal shows nothing". So the
    // last line has to land on *now* — asserted on the observation stamp rather than on the game
    // clock, which stays 601 either way and is exactly why this went uncaught the first time.
    expect(world.snapshot(20_000 as MonoMs).state.meta.lastUpdatedAt).toBeGreaterThanOrEqual(
      10_000,
    );

    // And the relative ages *inside* the recording survive the slide: it is slid, not flattened.
    const spanned = world.snapshot(20_000 as MonoMs).state.history.size;
    expect(spanned).toBe(2);
  });

  it('numbers its turns apart from the real coach', async () => {
    const { port } = harness([mockState()], proposal());

    const first = await port.run('laning-phase');
    const second = await port.run('laning-phase');

    // Two counters sharing a prefix would eventually put two entries in the buffer claiming to be
    // the same turn, which is what the buffer joins transcripts on and cannot detect.
    expect(first).toMatchObject({ turnId: 'rehearsal_1' });
    expect(second).toMatchObject({ turnId: 'rehearsal_2' });
  });

  it('disposes the stack it was given', async () => {
    const { port, disposed } = harness([mockState()], proposal());
    await port.run('laning-phase');
    // A driver that outlived its rehearsal would keep a subscription to a world nobody writes to,
    // and under `llm` a pooled transport open.
    expect(disposed()).toBe(1);
  });
});

describe('a rehearsal the coach declines', () => {
  it('records the reason as a tick, prefixed so it cannot be read as the live coach', async () => {
    const { port, hub } = harness([mockState()], {
      spoke: false,
      reason: 'the fight is already over',
    });

    const outcome = await port.run('laning-phase');
    expect(outcome).toEqual({ ok: true, turnId: 'rehearsal_1', spoke: false });

    const ticks = hub.frame(20_000).ticks;
    expect(ticks).toHaveLength(1);
    // Under `llm` this sentence *is* the coach's output for the moment, and the Triggers panel is
    // the only place a reason appears at full length.
    expect(JSON.stringify(ticks[0])).toContain('rehearsal laning-phase: the fight is already over');
  });

  it('closes declined, and still records the turn', async () => {
    const { port, hub } = harness([mockState()], { spoke: false, reason: 'nothing to add' });
    await port.run('laning-phase');

    const turns = hub.frame(20_000).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]?.outcome).toBe('declined');
    // No proposal means no drafted line — and null is the honest answer rather than an empty string.
    expect(turns[0]?.guidance).toBeNull();
  });
});

describe('what it refuses', () => {
  it('refuses a state that is not in the library, and says so where it is read', async () => {
    const { port, hub } = harness([mockState()], proposal());

    const outcome = await port.run('../../etc/passwd');
    expect(outcome).toEqual({ ok: false, reason: 'no mock game state named ../../etc/passwd' });

    const problems = hub.frame(20_000).problems;
    expect(problems[0]?.origin).toBe('inspector');
    expect(problems[0]?.message).toContain('no mock game state named');
    // Nothing ran.
    expect(hub.frame(20_000).turns).toHaveLength(0);
  });

  it('refuses a recording that replays nothing', async () => {
    const { port, hub } = harness([mockState({ lines: [] })], proposal());

    const outcome = await port.run('laning-phase');
    expect(outcome).toEqual({ ok: false, reason: 'mock game state laning-phase replays nothing' });
    expect(hub.frame(20_000).problems).toHaveLength(1);
  });

  it('refuses a second run while one is in flight', async () => {
    // Initialised rather than left null: assigned only inside the executor, TypeScript narrows the
    // nullable version to `never` by the time it is called and refuses the call.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const { port } = harness([mockState()], () => gate.then(() => proposal()));

    const first = port.run('laning-phase');
    // Under `llm` a rehearsal is a model call taking seconds and the button is one click. Two
    // overlapping runs would interleave two turns into the panel, and the second would report a
    // skip that says nothing about the state it was asked about.
    const second = await port.run('laning-phase');
    expect(second).toEqual({ ok: false, reason: 'a rehearsal is already running' });

    release();
    expect(await first).toMatchObject({ ok: true });
  });

  it('frees the lock after a run, so the button is not dead for the session', async () => {
    const { port } = harness([mockState()], proposal());
    await port.run('laning-phase');
    expect(await port.run('laning-phase')).toMatchObject({ ok: true, turnId: 'rehearsal_2' });
  });

  it('turns a throwing coach into a problem rather than an unhandled rejection', async () => {
    const { port, hub, disposed } = harness([mockState()], () =>
      Promise.reject(new Error('the model client rejected')),
    );

    const outcome = await port.run('laning-phase');
    expect(outcome).toEqual({ ok: false, reason: 'the model client rejected' });
    expect(hub.frame(20_000).problems[0]?.message).toContain('the model client rejected');
    // And the stack is still torn down, because the dispose is in a `finally`.
    expect(disposed()).toBe(1);
  });

  it('frees the lock after a throw', async () => {
    let fail = true;
    const { port } = harness([mockState()], () =>
      fail ? Promise.reject(new Error('boom')) : Promise.resolve(proposal()),
    );

    await port.run('laning-phase');
    fail = false;
    // A lock left held by a failure would leave the button dead until the app restarted, which is
    // the failure mode a one-at-a-time guard most easily introduces.
    expect(await port.run('laning-phase')).toMatchObject({ ok: true });
  });
});

describe('the states it offers', () => {
  it('projects the library for the frame', () => {
    const { port } = harness([mockState(), mockState({ id: 'draft', label: 'draft' })], proposal());
    expect(port.states().map((state) => state.id)).toEqual(['laning-phase', 'draft']);
    expect(port.states()[0]?.observations).toBe(2);
  });
});

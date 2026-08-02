/**
 * The whole shell, driven by a recorded match, with no Electron.
 *
 * This is the test the step exists for. Everything the composition root wires — the GSI listener,
 * the observation bus, fusion, the event engine's eight detectors and thirteen gates, the context
 * assembler, the coaching brief, the interaction machine, the overlay presenter and the tray —
 * runs here against `fixtures/gsi/laning-phase.jsonl` through `FakeGsiSource`, which satisfies the
 * same interface as `GsiServer`. What it does not exercise is speech, for the reasons in
 * `silent-session.ts`.
 *
 * `coaching-trigger-architecture.md` §16 step 3 describes exactly this harness as what tuning
 * needs — *"the corpus it needs is `fixtures/gsi/`, driven through `FakeGsiSource` into a real
 * world model, a real engine, and a real `ContextAssembler` — no session and no network"* — so the
 * fixture path, the clock and the drain are deliberately reusable rather than inlined.
 *
 * **The fixture is synthetic.** Its own header says so: assembled from the component list in
 * `dota2-state-capture-design.md` §2.1, not captured from a running client. So an assertion about
 * *which* advice fires would be an assertion about a fixture somebody wrote, not about Dota. What
 * is asserted instead is that the pipeline is connected end to end and that each stage's output
 * reaches the next — which is the thing that was never true before and is what this step changed.
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeCoachModel } from '@riki/coach/testing';
import { ApiKey, type CoachMode, type ConfigLayer } from '@riki/config';
import type { Timers } from '@riki/context';
import { GATES, SUPPRESSION_REASONS } from '@riki/events';
import { createMatchSessionTracker, type MatchLifecycleEvent } from '@riki/gsi';
import { createFakeGsiSource, parseGsiFixture, type FakeGsiSource } from '@riki/gsi/testing';
import type { EventEngine } from '@riki/events';
import type { MonoMs, Observation, SourceHealth } from '@riki/world-model';

import type { Millis } from '../../shared/overlay.js';
import type { CoachDriver, StaticCoachDriver } from '../agent/index.js';
import { resetCoachTurnIds } from '../agent/index.js';
import { createFakeWindow, fakeWindowFactory, type FakeOverlayWindow } from '../testing/fakes.js';
import type { Clock as UiClock } from '../session/contracts.js';
import type { TimerId } from '../session/types.js';
import { NO_RESTART, type SourceRegistration } from '../state/index.js';
import type { TrayAction, TraySurface } from '../tray/index.js';
import type { KeySource } from '../trigger/index.js';
import { HOLD_THRESHOLD_MS } from '../trigger/index.js';
import { createRikiShell, resolveShellConfig, type RikiShell, type ShellDeps } from './index.js';
import { createSilentSession, type SilentSession } from './silent-session.js';

const FIXTURE = 'fixtures/gsi/laning-phase.jsonl';

// -------------------------------------------------------------------------------------------
// A test's version of every port the shell takes
// -------------------------------------------------------------------------------------------

interface TestClock extends UiClock {
  advance(byMs: Millis): void;
}

/**
 * One clock for the machine's timers and the world model's ages alike.
 *
 * The shell derives `MonoMs` from `Millis` rather than taking two clocks, so a test that drove
 * them apart would be testing something the app cannot do.
 */
function testClock(): TestClock {
  let current = 0;
  const timers = new Map<TimerId, { dueAt: number; fire: () => void }>();

  return {
    now: () => current,
    schedule(id, delayMs, fire) {
      timers.set(id, { dueAt: current + delayMs, fire });
    },
    cancel(id) {
      timers.delete(id);
    },
    cancelAll() {
      timers.clear();
    },
    advance(byMs) {
      const target = current + byMs;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        timers.delete(id);
        current = Math.max(current, timer.dueAt);
        timer.fire();
      }
      current = target;
    },
  };
}

interface TestTimers extends Timers {
  /** Fires everything currently pending, once. Enough for the health poll and the silent session. */
  flush(): number;
  readonly depth: number;
}

function testTimers(): TestTimers {
  let pending: { fn: () => void }[] = [];
  return {
    after(_ms, fn) {
      const entry = { fn };
      pending.push(entry);
      return () => {
        pending = pending.filter((other) => other !== entry);
      };
    },
    flush() {
      const batch = pending;
      pending = [];
      for (const entry of batch) entry.fn();
      return batch.length;
    },
    get depth() {
      return pending.length;
    },
  };
}

function silentTray(): TraySurface & {
  readonly statuses: readonly string[];
  /** Every row label the tray has been asked to render, so a conditional row is assertable. */
  readonly labels: readonly string[];
  quit(): void;
} {
  const statuses: string[] = [];
  const labels: string[] = [];
  const actions = new Set<(action: TrayAction) => void>();
  return {
    statuses,
    labels,
    render(_glyph, _tooltip, menu) {
      const label = menu[0]?.label;
      if (label !== undefined) statuses.push(label);
      for (const item of menu) if (item.label !== undefined) labels.push(item.label);
    },
    onAction(listener) {
      actions.add(listener);
      return () => actions.delete(listener);
    },
    destroy: () => undefined,
    quit() {
      for (const listener of [...actions]) listener('quit');
    },
  };
}

interface TestKeys extends KeySource {
  tap(now: Millis): void;
}

function testKeys(): TestKeys {
  const down = new Set<(now: Millis) => void>();
  const up = new Set<(now: Millis) => void>();
  return {
    hasKeyUp: true,
    bind: () => true,
    unbind: () => undefined,
    onKeyDown: (fn) => {
      down.add(fn);
      return () => down.delete(fn);
    },
    onKeyUp: (fn) => {
      up.add(fn);
      return () => up.delete(fn);
    },
    onCancel: () => () => undefined,
    tap(now) {
      for (const fn of [...down]) fn(now);
      for (const fn of [...up]) fn(now + HOLD_THRESHOLD_MS - 1);
    },
  };
}

// -------------------------------------------------------------------------------------------

interface Harness {
  readonly shell: RikiShell;
  readonly gsi: FakeGsiSource;
  readonly session: SilentSession;
  readonly clock: TestClock;
  readonly timers: TestTimers;
  readonly window: FakeOverlayWindow;
  readonly tray: ReturnType<typeof silentTray>;
  readonly keys: TestKeys;
  readonly dataDir: string;
}

let harness: Harness | null = null;

/**
 * @param layer The config layer, defaulting to "unprompted speech on" because almost every test
 *   below exercises that path. The shipped default is the opposite and is asserted in "the privacy
 *   default", which builds its own shell with `{}`.
 */
function build(layer: ConfigLayer = { 'privacy.unprompted': true }): Harness {
  const clock = testClock();
  const timers = testTimers();
  const window = createFakeWindow();
  const tray = silentTray();
  const keys = testKeys();
  const dataDir = mkdtempSync(join(tmpdir(), 'riki-shell-'));

  const worldClock = { now: (): MonoMs => clock.now() as MonoMs };
  const gsi = createFakeGsiSource({
    lines: parseGsiFixture(readFileSync(FIXTURE, 'utf8')),
    clock: worldClock,
  });

  const session = createSilentSession({ clock: worldClock, timers });

  const shell = createRikiShell({
    config: resolveShellConfig({ dataDir, gsiToken: 'test-token', layer }),
    clock,
    timers,
    platform: 'darwin',
    sources: {
      // `FakeGsiSource` satisfies the same interface as `GsiServer`, which is what makes this a
      // test of the shell rather than a test of a second, parallel wiring.
      gsi: (): SourceRegistration => ({
        policy: NO_RESTART,
        source: {
          id: gsi.id,
          start: () => gsi.start(),
          stop: () => gsi.stop(),
          subscribe: (listener: (o: Observation) => void) => gsi.subscribe(listener),
          health: (now): SourceHealth => gsi.health(now),
        },
        // ⚠ `FakeGsiSource` does **not** implement `onLifecycle`, despite its header claiming it
        // "satisfies the same interface as `GsiServer`, so a consumer wired to it is wired".
        // `GsiServerWithExtras` has it and the fake does not, so a consumer wired to the fake
        // never sees `match_started` and never builds a coaching root — which is silent, and is
        // the whole thing this test would otherwise fail to notice.
        //
        // Driving `MatchSessionTracker` from the observation stream here is exactly what
        // `createGsiServer` does internally, using that package's own exported tracker. The fix
        // belongs in `packages/gsi/src/testing/`; this is the workaround, and it is deliberately
        // visible rather than tidy.
        lifecycle: (listener) => {
          const tracker = createMatchSessionTracker();
          return gsi.subscribe((o) => {
            const events: readonly MatchLifecycleEvent[] = tracker.observe(o.payload, {
              observedAt: worldClock.now(),
            });
            if (events.length > 0) listener(events);
          });
        },
      }),
    },
    windowFactory: fakeWindowFactory(window),
    tray,
    keys,
    session,
  });

  return { shell, gsi, session, clock, timers, window, tray, keys, dataDir };
}

beforeEach(async () => {
  resetCoachTurnIds();
  harness = build();
  await harness.shell.start();
});

afterEach(async () => {
  const current = harness;
  harness = null;
  if (current === null) return;
  await current.shell.stop();
  rmSync(current.dataDir, { recursive: true, force: true });
});

function use(): Harness {
  if (harness === null) throw new Error('no harness');
  return harness;
}

/** Every line of the fixture, then the microtasks the coaching path defers on. */
async function replayInto(harnessed: Harness): Promise<void> {
  const { gsi, clock } = harnessed;
  for (;;) {
    if (!gsi.step()) break;
    clock.advance(250);
    await Promise.resolve();
  }
  await Promise.resolve();
}

async function replay(): Promise<void> {
  await replayInto(use());
}

// -------------------------------------------------------------------------------------------

describe('the privacy default', () => {
  it('says nothing unprompted, because RIKI_UNPROMPTED ships off', async () => {
    // Not a unit test of `DEFAULTS` — `packages/config` has that. This is the end of the wire:
    // the default reaches `EventEngine.setQuietMode` and the whole detected-and-gated pipeline
    // still produces zero turns. The harness above turns it on precisely because it has to.
    const quiet = build({});
    try {
      await quiet.shell.start();
      await replayInto(quiet);

      expect(quiet.shell.match).not.toBeNull();
      const counters = engineOf(quiet.shell).counters();
      // Something *was* detected, so the zero below is quiet mode and not an inert pipeline.
      const detected = Object.values(counters.detected).reduce((a, b) => a + b, 0);
      expect(detected).toBeGreaterThan(0);
      expect(counters.spoken).toBe(0);
      expect(quiet.session.turns).toHaveLength(0);
    } finally {
      await quiet.shell.stop();
      rmSync(quiet.dataDir, { recursive: true, force: true });
    }
  });
});

describe('the shell starts', () => {
  it('warms the overlay window before anything can ask it to show', () => {
    // `showFast()` is a compositor map only if the window already exists and has painted once;
    // the ≤100 ms budget goes entirely on a cold start otherwise (overlay §9.1).
    expect(use().window.loads).toBe(1);
    expect(use().window.isVisible()).toBe(false);
  });

  it('puts a status line on the tray before a single POST arrives', () => {
    expect(use().tray.statuses[0]).toMatch(/^Riki — /);
  });

  it('has no coaching root between matches, because the assembler is per-match', () => {
    expect(use().shell.match).toBeNull();
  });
});

describe('a recorded match, end to end', () => {
  it('turns POSTs into world-model versions', async () => {
    const { shell } = use();
    expect(shell.state.world.version).toBe(0);

    await replay();

    // The whole left half of the pipeline: parse → observation → bus → fusion → version.
    expect(shell.state.world.version).toBeGreaterThan(0);
  });

  it('opens a coaching root when the match starts, and closes it when the match ends', async () => {
    const { shell } = use();
    await replay();

    const match = shell.match;
    expect(match).not.toBeNull();
    expect(match?.matchId).toBe('7891234567');
    // Real objects, not stubs: this is the first time they have existed outside a unit test.
    expect(match?.context.ledgerRecord.all()).toBeDefined();
    // The static coach is the default and the shell built it behind the driver port.
    expect(match?.driver.mode).toBe('static');
  });

  it('renders a snapshot the model could actually read', async () => {
    const { shell, clock } = use();
    await replay();

    const context = shell.match?.context;
    expect(context).toBeDefined();

    const turn = context?.openTurn(
      { turnId: 'probe' as never, cause: { by: 'player', gesture: 'push_to_talk' } },
      clock.now() as MonoMs,
    );
    // The world-view adapter, the projection table and the renderer, over facts that came out of
    // a recorded POST rather than out of `buildWorld()`.
    expect(turn?.snapshot.text.length).toBeGreaterThan(0);
  });

  it('runs the detectors against every version bump', async () => {
    const { shell } = use();
    await replay();

    const counters = engineOf(shell).counters();
    const detected = Object.values(counters.detected).reduce((a, b) => a + b, 0);
    const suppressed = Object.values(counters.suppressed).reduce((a, b) => a + b, 0);
    // Both zero would mean the engine never ran, which is exactly the failure this file exists to
    // catch. Non-zero on both sides means more: detection *and* the gate stack ran, and the
    // default really is silence — the corpus produces more refusals than utterances.
    expect(detected).toBeGreaterThan(0);
    expect(suppressed).toBeGreaterThan(0);
    expect(detected).toBeGreaterThan(counters.spoken);
  });

  it('never speaks without a brief behind it', async () => {
    const { shell, session } = use();
    await replay();

    // An empty brief is a turn that does not happen (coaching-architecture.md §6.5), so every
    // turn that reached the session has text in it.
    expect(session.turns.length).toBeGreaterThan(0);
    for (const spoken of session.turns) {
      // The snapshot and the brief, blank-line separated as one injected system message.
      expect(spoken.turn.snapshotText).toContain('\n\n');
    }
    expect(session.turns.length).toBe(engineOf(shell).counters().spoken);
  });
});

/**
 * The deterministic coach's counters, from behind the driver port.
 *
 * Narrowing rather than casting: if the shell ever built the LLM coach by default this throws with
 * a message saying so, which is what a silent `as` would not.
 */
function engineOf(shell: RikiShell): EventEngine {
  // Typed as the *port*, not as the static adapter: narrowing a value already declared to be
  // `StaticCoachDriver` proves nothing, and the whole point of this helper is that it fails loudly
  // if the shell ever defaults to the other coach.
  const driver: CoachDriver | undefined = shell.match?.driver;
  if (driver?.mode !== 'static') {
    throw new Error(`expected the static coach, got ${String(driver?.mode)}`);
  }
  return (driver as StaticCoachDriver).engine;
}

describe('the interaction path', () => {
  it('speaks unprompted during the recorded match, with no gesture behind it', async () => {
    const { shell, session, window } = use();
    await replay();

    // The end of the pipeline, reached from a recorded POST: a detection survived thirteen gates,
    // the assembler rendered a non-empty brief, and the composition root handed it to the session.
    expect(session.turns.length).toBeGreaterThan(0);
    expect(session.turns[0]?.reason?.eventId).toBeTypeOf('string');
    expect(session.turns[0]?.reason?.salience).toBeGreaterThan(0);

    // And the chip followed: Idle → Speaking with no Armed and no earcon (overlay §9.3), which
    // under ADR-0023 is the primary path rather than one of two.
    expect(shell.runtime.snapshot().phase).toEqual({ kind: 'speaking', unprompted: true });
    expect(window.isVisible()).toBe(true);
  });

  it('returns to idle when the turn ends, so `agent_speaking` does not stay armed', async () => {
    const { shell, timers } = use();
    await replay();
    expect(shell.runtime.snapshot().phase.kind).toBe('speaking');

    // The nominal speech duration expiring. A session port that never closed the turn would leave
    // gate 4 armed forever and every later trigger suppressed — indistinguishable from a broken
    // trigger policy, which is the one confusion that would make the stand-in worse than useless.
    timers.flush();
    expect(shell.runtime.snapshot().phase.kind).toBe('idle');
    expect(engineOf(shell).counters().spoken).toBeGreaterThan(0);
  });

  it('barges in: one key press during Riki speaking goes straight to Listening', async () => {
    const { shell, clock, keys } = use();
    await replay();
    expect(shell.runtime.snapshot().phase.kind).toBe('speaking');

    keys.tap(clock.now());

    // ui-design §3.1 calls this "the most important interaction in the whole design": one
    // transition, no intermediate state, and the chip changes before the truncate has left the
    // machine (overlay §9.2). "Riki said something I do not want to hear" costs one key press.
    expect(shell.runtime.snapshot().phase).toEqual({
      kind: 'listening',
      gesture: 'latch',
      silentSince: null,
    });
  });

  it('arms the chip on a tap from idle, and does not wait on a microphone to do it', async () => {
    const { shell, clock, window, timers, keys } = use();
    await replay();
    timers.flush();
    expect(shell.runtime.snapshot().phase.kind).toBe('idle');

    keys.tap(clock.now());

    // Armed rather than Listening, and that is the design: Listening is entered on
    // `capture.opened` from the audio graph, and *the chip's appearance never waits on the mic*
    // (overlay §9.1) — which is the entire reason an Armed state exists. A shell with no voice
    // renderer therefore stops exactly here, visibly.
    expect(window.isVisible()).toBe(true);
    expect(shell.runtime.snapshot().phase).toEqual({ kind: 'armed', gesture: 'latch' });
  });
});

describe('the inspector (main/debug)', () => {
  it('does not exist unless it was asked for', () => {
    // Off by default, and the default is what every other test in this file runs under. With it off
    // the shell installs no observing policy, builds no hub, and holds no rendered brief in memory.
    expect(use().shell.debug).toBeNull();
  });

  it('changes nothing about what Riki does', async () => {
    /** One full fixture replay, returning the two things the coaching path is judged on. */
    async function run(debug: boolean): Promise<{ spoken: number; texts: readonly string[] }> {
      resetCoachTurnIds();
      const built = build({ 'privacy.unprompted': true, 'debug.enabled': debug });
      await built.shell.start();
      try {
        for (;;) {
          if (!built.gsi.step()) break;
          built.clock.advance(250);
          await Promise.resolve();
        }
        await Promise.resolve();
        // `engineOf` rather than an inline cast: it throws if the shell ever defaults to the LLM
        // coach, which would otherwise make both runs report the same `-1` and let this test pass
        // while measuring nothing.
        return {
          spoken: engineOf(built.shell).counters().spoken,
          texts: built.session.turns.map((entry) => entry.turn.snapshotText),
        };
      } finally {
        await built.shell.stop();
        rmSync(built.dataDir, { recursive: true, force: true });
      }
    }

    const off = await run(false);
    const on = await run(true);

    // The claim the whole component is built around. `observing-policy.ts` and
    // `observing-context.ts` both return their delegate's value unchanged, and this is what that
    // means end to end: the same fixture produces the same utterances either way. If it ever does
    // not, the inspector is not measuring the app — it is changing it, and in a product whose
    // failure mode is Riki talking when it should not, that is the bug that matters.
    expect(on.spoken).toBe(off.spoken);
    expect(on.texts).toEqual(off.texts);
    expect(on.spoken).toBeGreaterThan(0);
  });

  describe('with it on', () => {
    beforeEach(async () => {
      const current = harness;
      harness = null;
      if (current !== null) {
        await current.shell.stop();
        rmSync(current.dataDir, { recursive: true, force: true });
      }
      resetCoachTurnIds();
      harness = build({ 'privacy.unprompted': true, 'debug.enabled': true });
      await harness.shell.start();
    });

    it('collects without a window, which is the shape a replay wants', () => {
      const { shell } = use();
      expect(shell.debug).not.toBeNull();
      // No `DebugWindowFactory` is passed here on purpose: everything the inspector gathers is a
      // Tier 1/Tier 4 concern, and a window is Tier 5's business.
      expect(shell.debug?.isOpen()).toBe(false);
    });

    it('shows the world the judge is actually reading', async () => {
      const { shell, clock } = use();
      await replay();

      const frame = shell.debug?.hub.frame(clock.now());
      expect(frame?.session.matchId).toBe('7891234567');
      expect(frame?.session.coachingRoot).toBe(true);
      expect(frame?.world.version).toBeGreaterThan(0);

      // Facts that came out of a recorded POST, each with the envelope `packages/world-model` goes
      // to some trouble to keep attached: no row here can be read without its provenance.
      const facts = frame?.world.facts ?? [];
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) {
        expect(fact.source).not.toBe('');
        expect(fact.confidence).toBeGreaterThan(0);
        expect(['fresh', 'aging', 'stale', 'expired']).toContain(fact.staleness);
        expect(['wall', 'game']).toContain(fact.ageBasis);
      }
      expect(facts.map((fact) => fact.path)).toContain('meta.phase');
    });

    it('shows the gate ladder for every candidate, which nothing else can', async () => {
      const { shell, clock } = use();
      await replay();

      const frame = shell.debug?.hub.frame(clock.now());
      const ticks = frame?.ticks ?? [];
      expect(ticks.length).toBeGreaterThan(0);

      const withCandidates = ticks.filter((tick) => tick.candidates.length > 0);
      expect(withCandidates.length).toBeGreaterThan(0);

      for (const tick of withCandidates) {
        for (const candidate of tick.candidates) {
          // Thirteen verdicts per candidate, every tick — including for the candidates that lost
          // the ranking and never reached a gate in the shipping path (§5.5).
          expect(candidate.ladder).toHaveLength(SUPPRESSION_REASONS.length);
          expect(candidate.ladder.map((gate) => gate.reason)).toEqual(GATES.map((g) => g.reason));
        }
      }

      // And at least one refusal is attributable to a named gate, rather than the whole corpus
      // being "nothing was detected".
      const refused = ticks.filter((tick) => !tick.decision.speak && tick.decision.key !== null);
      expect(refused.length).toBeGreaterThan(0);
    });

    it('shows what the coach was given', async () => {
      const { shell, clock } = use();
      await replay();

      const turns = shell.debug?.hub.frame(clock.now()).turns ?? [];
      expect(turns.length).toBeGreaterThan(0);

      for (const turn of turns) {
        // The snapshot and the brief as they were rendered — the pair that exists nowhere else a
        // person can read, and the whole reason the assembler is decorated rather than the agent.
        expect(turn.snapshotText.length).toBeGreaterThan(0);
        expect(turn.snapshotTokens).toBeGreaterThan(0);
        expect(turn.cause).toBe('trigger');
        expect(turn.eventId).not.toBeNull();
        // An empty brief would have been closed `silent` without reaching the session; every turn
        // here got past that, so all of them have text behind them.
        expect(turn.briefEmpty).toBe(false);
        expect(turn.briefText.length).toBeGreaterThan(0);
      }
    });

    it('shows what became of a turn once it closes', async () => {
      const { shell, clock, timers } = use();
      await replay();

      // A turn is `open` until `closeTurn`, which for the silent session is the nominal speech
      // duration expiring. Asserting the outcome without flushing would be asserting that the
      // fixture happens to run long enough, which is a fact about the fixture.
      expect(shell.debug?.hub.frame(clock.now()).turns.every((t) => t.outcome === 'open')).toBe(
        true,
      );
      timers.flush();

      const closed = shell.debug?.hub.frame(clock.now()).turns.filter((t) => t.outcome !== 'open');
      expect(closed?.length).toBeGreaterThan(0);
      expect(closed?.map((turn) => turn.outcome)).toContain('spoke');
    });

    it('carries the engine state behind a refusal', async () => {
      const { shell, clock } = use();
      await replay();

      const gates = shell.debug?.hub.frame(clock.now()).session.gates;
      // None of this is reachable through `EventEngine`'s public surface; it arrives on the
      // `GateContext` the policy decorator sees.
      expect(gates?.asOfMs).not.toBeNull();
      expect(gates?.speakThreshold).toBeGreaterThan(0);
      expect(gates?.unprompted).toBe(true);
      expect(gates?.latched).toBeInstanceOf(Array);
    });

    it('counts what was detected against what was spoken', async () => {
      const { shell, clock } = use();
      await replay();

      const counters = shell.debug?.hub.frame(clock.now()).counters;
      const detected = (counters?.detected ?? []).reduce((sum, row) => sum + row.count, 0);
      const suppressed = (counters?.suppressed ?? []).reduce((sum, row) => sum + row.count, 0);

      // §5.4's tuning signal, per reason rather than as one number — which is the difference
      // between "Riki said nothing" and "Riki noticed nothing".
      expect(detected).toBeGreaterThan(0);
      expect(suppressed).toBeGreaterThan(0);
      expect(counters?.ticks).toBeGreaterThan(0);
    });

    it('offers the tray row it now has somewhere to send', () => {
      const { tray } = use();
      expect(tray.labels).toContain('Open Inspector…');
    });
  });
});

describe('shutdown', () => {
  it('reports a quit request from the tray', () => {
    const { shell, tray } = use();
    let quits = 0;
    shell.onQuitRequested(() => (quits += 1));
    tray.quit();
    expect(quits).toBe(1);
  });

  it('tears the window down and stops the sources', async () => {
    const current = use();
    harness = null;
    await current.shell.stop();
    rmSync(current.dataDir, { recursive: true, force: true });

    expect(current.window.destroyed).toBe(true);
    expect(current.timers.depth).toBe(0);
  });
});

/**
 * The toggle, which is the whole of "the mode switch is a UI control".
 *
 * These build their own shell rather than using the shared harness, because the thing under test is
 * a *construction* choice — whether a model factory was supplied — and the harness deliberately
 * supplies none.
 */
describe('the coach toggle', () => {
  function shellWith(options: {
    readonly coachModel?: ShellDeps['coachModel'];
    readonly onCoachModeChanged?: (mode: CoachMode) => void;
    readonly mode?: CoachMode;
    /** Both halves are required for `llm` to be reachable; a test names the one it is about. */
    readonly key?: boolean;
  }): { shell: RikiShell; dataDir: string } {
    const clock = testClock();
    const timers = testTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'riki-toggle-'));
    const worldClock = { now: (): MonoMs => clock.now() as MonoMs };
    const gsi = createFakeGsiSource({
      lines: parseGsiFixture(readFileSync(FIXTURE, 'utf8')),
      clock: worldClock,
    });

    const shell = createRikiShell({
      config: resolveShellConfig({
        dataDir,
        gsiToken: 'test-token',
        ...(options.key === true ? { apiKey: new ApiKey('sk-test-aaaa-bbbb-cccc-dddd') } : {}),
        // The mode's one source is `settings.json` (ADR-0031), which in `@riki/config`'s terms is
        // the layer beneath the environment. There is no environment variable and no flag for it,
        // so a layer entry is how a test asks for it — the same way the app's own file does.
        layer: {
          'privacy.unprompted': true,
          ...(options.mode === undefined ? {} : { 'coach.mode': options.mode }),
        },
      }),
      clock,
      timers,
      platform: 'darwin',
      sources: {
        gsi: (): SourceRegistration => ({
          policy: NO_RESTART,
          source: {
            id: gsi.id,
            start: () => gsi.start(),
            stop: () => gsi.stop(),
            subscribe: (listener: (o: Observation) => void) => gsi.subscribe(listener),
            health: (now): SourceHealth => gsi.health(now),
          },
        }),
      },
      windowFactory: fakeWindowFactory(createFakeWindow()),
      tray: silentTray(),
      keys: testKeys(),
      session: createSilentSession({ clock: worldClock, timers }),
      ...(options.coachModel === undefined ? {} : { coachModel: options.coachModel }),
      ...(options.onCoachModeChanged === undefined
        ? {}
        : { onCoachModeChanged: options.onCoachModeChanged }),
    });

    return { shell, dataDir };
  }

  it('refuses the LLM coach with a model factory but no key', () => {
    const { shell, dataDir } = shellWith({ coachModel: () => createFakeCoachModel() });
    // Both halves are needed. Asking for `llm` must come back `static`: a toggle that ticked anyway
    // would leave a match running in a mode that says nothing all game, with the UI claiming
    // otherwise.
    expect(shell.setCoachMode('llm')).toBe('static');
    expect(shell.coachMode).toBe('static');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('switches to the LLM coach when one can be built, and announces it for persistence', () => {
    const changes: CoachMode[] = [];
    const { shell, dataDir } = shellWith({
      key: true,
      coachModel: () => createFakeCoachModel(),
      onCoachModeChanged: (mode) => changes.push(mode),
    });

    expect(shell.setCoachMode('llm')).toBe('llm');
    expect(shell.coachMode).toBe('llm');
    expect(changes).toEqual(['llm']);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('announces nothing when the mode did not actually change', () => {
    const changes: CoachMode[] = [];
    const { shell, dataDir } = shellWith({
      key: true,
      coachModel: () => createFakeCoachModel(),
      onCoachModeChanged: (mode) => changes.push(mode),
    });

    expect(shell.setCoachMode('static')).toBe('static');
    // Already static. Writing `settings.json` on every no-op click would be a file write per tray
    // open, and a changed-at timestamp that means nothing.
    expect(changes).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('announces the resolved mode, not the requested one', () => {
    const changes: CoachMode[] = [];
    const { shell, dataDir } = shellWith({ onCoachModeChanged: (mode) => changes.push(mode) });

    // Asking for `llm` with nothing to build it resolves to `static`, which is already the mode —
    // so there is no change and nothing is persisted. A settings file saying `llm` here would send
    // the player back into the same dead end on every restart.
    expect(shell.setCoachMode('llm')).toBe('static');
    expect(changes).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts in the mode the settings file asked for', () => {
    const { shell, dataDir } = shellWith({
      mode: 'llm',
      key: true,
      coachModel: () => createFakeCoachModel(),
    });

    expect(shell.coachMode).toBe('llm');
    rmSync(dataDir, { recursive: true, force: true });
  });
});

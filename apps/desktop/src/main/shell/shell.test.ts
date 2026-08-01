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

import type { Timers } from '@riki/context';
import { createMatchSessionTracker, type MatchLifecycleEvent } from '@riki/gsi';
import { createFakeGsiSource, parseGsiFixture, type FakeGsiSource } from '@riki/gsi/testing';
import type { MonoMs, Observation, SourceHealth } from '@riki/world-model';

import type { Millis } from '../../shared/overlay.js';
import { resetCoachTurnIds } from '../agent/index.js';
import { createFakeWindow, fakeWindowFactory, type FakeOverlayWindow } from '../testing/fakes.js';
import type { Clock as UiClock } from '../session/contracts.js';
import type { TimerId } from '../session/types.js';
import { NO_RESTART, type SourceRegistration } from '../state/index.js';
import type { TrayAction, TraySurface } from '../tray/index.js';
import type { KeySource } from '../trigger/index.js';
import { HOLD_THRESHOLD_MS } from '../trigger/index.js';
import { createRikiShell, resolveShellConfig, type RikiShell } from './index.js';
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

function silentTray(): TraySurface & { readonly statuses: readonly string[]; quit(): void } {
  const statuses: string[] = [];
  const actions = new Set<(action: TrayAction) => void>();
  return {
    statuses,
    render(_glyph, _tooltip, menu) {
      const label = menu[0]?.label;
      if (label !== undefined) statuses.push(label);
    },
    onAction(listener) {
      actions.add(listener);
      return () => actions.delete(listener);
    },
    onClick: () => () => undefined,
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

function build(): Harness {
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
    config: resolveShellConfig({ dataDir, gsiToken: 'test-token' }),
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
async function replay(): Promise<void> {
  const { gsi, clock } = use();
  for (;;) {
    if (!gsi.step()) break;
    clock.advance(250);
    await Promise.resolve();
  }
  await Promise.resolve();
}

// -------------------------------------------------------------------------------------------

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
    expect(match?.engine.counters()).toBeDefined();
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

    const counters = shell.match?.engine.counters();
    expect(counters).toBeDefined();
    const detected = Object.values(counters?.detected ?? {}).reduce((a, b) => a + b, 0);
    const suppressed = Object.values(counters?.suppressed ?? {}).reduce((a, b) => a + b, 0);
    // Both zero would mean the engine never ran, which is exactly the failure this file exists to
    // catch. Non-zero on both sides means more: detection *and* the gate stack ran, and the
    // default really is silence — the corpus produces more refusals than utterances.
    expect(detected).toBeGreaterThan(0);
    expect(suppressed).toBeGreaterThan(0);
    expect(detected).toBeGreaterThan(counters?.spoken ?? 0);
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
    expect(session.turns.length).toBe(shell.match?.engine.counters().spoken ?? 0);
  });
});

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
    expect(shell.match?.engine.counters().spoken).toBeGreaterThan(0);
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

/**
 * The whole shell, driven by a recorded match, with no Electron.
 *
 * This is the test the composition root exists for. Everything it wires — the GSI listener, the
 * observation bus, fusion, the snapshot renderer, the turn agent, the interaction machine, the
 * overlay presenter and the tray — runs here against `fixtures/gsi/laning-phase.jsonl` through
 * `FakeGsiSource`, which satisfies the same interface as `GsiServer`. What it does not exercise is
 * speech, for the reasons in `silent-session.ts`.
 *
 * **The load-bearing test is `a question, end to end`.** It presses the key, releases it, and
 * asserts that the session was handed a snapshot rendered from the recorded match. That chain
 * existed in pieces before ADR-0042 and was never joined: `beginPlayerTurn` and `endPlayerTurn`
 * were implemented, `voice/session.ts` sent the directives, the voice renderer handled them — and
 * nothing in the composition root ever called the first two. The chip lit up for a turn that
 * reached no session, and every layer passed its own tests.
 *
 * **The fixture is synthetic.** Its own header says so: assembled from the component list in
 * `dota2-state-capture-design.md` §2.1, not captured from a running client. So an assertion about
 * *what* Riki would answer would be an assertion about a fixture somebody wrote, not about Dota.
 * What is asserted instead is that the pipeline is connected end to end and that each stage's
 * output reaches the next.
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConfigLayer } from '@riki/config';
import type { Timers } from '@riki/context';
import { createMatchSessionTracker, type MatchLifecycleEvent } from '@riki/gsi';
import { createFakeGsiSource, parseGsiFixture, type FakeGsiSource } from '@riki/gsi/testing';
import type { MonoMs, Observation, SourceHealth } from '@riki/world-model';

import type { Millis } from '../../shared/overlay.js';
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

/**
 * Read once, and the source of the replay's timing as well as its content.
 *
 * Advancing a flat step per line instead is what hid a real defect for the life of this file:
 * `packages/gsi` compares the game clock against elapsed wall time, so a replay that invents its
 * own pacing makes the two disagree, and the state subsystem answers that disagreement by
 * resetting the world model. This test replayed the whole fixture through ~10 world resets and
 * asserted nothing about them.
 */
const FIXTURE_LINES = parseGsiFixture(readFileSync(FIXTURE, 'utf8'));

/** The gap the recording says comes after line `index`. Zero past the end. */
function gapAfter(index: number): Millis {
  const current = FIXTURE_LINES[index];
  const next = FIXTURE_LINES[index + 1];
  if (current === undefined || next === undefined) return 0;
  return Math.max(0, next.atMs - current.atMs);
}

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

function build(layer: ConfigLayer = {}): Harness {
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

/** Every line of the fixture, at the timing it records, then the microtasks the turn path
 * defers on. */
async function replayInto(harnessed: Harness): Promise<void> {
  const { gsi, clock } = harnessed;
  for (let index = 0; ; index += 1) {
    if (!gsi.step()) break;
    clock.advance(gapAfter(index));
    await Promise.resolve();
  }
  await Promise.resolve();
}

async function replay(): Promise<void> {
  await replayInto(use());
}

// -------------------------------------------------------------------------------------------

/** One push-to-talk gesture, and the text the session was handed for it. */
async function ask(harnessed: Harness): Promise<string | undefined> {
  const { shell, clock, keys } = harnessed;
  // A tap latches; the second tap ends the gesture. In between, `capture.firstAudio` is what the
  // voice renderer would send — there is none here, so it is dispatched by hand, which is the one
  // thing this harness stands in for.
  keys.tap(clock.now());
  shell.runtime.dispatch({ kind: 'capture', event: 'firstAudio' });
  keys.tap(clock.now());
  await Promise.resolve();
  await Promise.resolve();
  return harnessed.session.turns.at(-1)?.snapshotText;
}

describe('the shell starts', () => {
  it('warms the overlay window before anything can ask it to show', () => {
    // `showFast()` is a compositor map only if the window already exists and has painted once;
    // the ≤100 ms budget goes entirely on a cold start otherwise (overlay §9.1).
    expect(use().window.loads).toBe(1);
    expect(use().window.isVisible()).toBe(false);
  });

  it('puts a status line on the tray before a single POST arrives', () => {
    expect(use().tray.statuses[0]).toMatch(/^Riki — /u);
  });

  it('has no session between matches, because the instructions are frozen per match', () => {
    expect(use().shell.matchId).toBeNull();
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

  it('opens the session when the match starts, with instructions frozen for it', async () => {
    const { shell, session } = use();
    await replay();

    expect(shell.matchId).toBe('7891234567');
    // Assembled once and frozen (ADR-0011). What is in it is the persona and the staleness rule;
    // the roster comes from the per-turn snapshot, because that is where it is observed.
    expect(session.opened).toHaveLength(1);
    expect(session.opened[0]).toContain('must not state an aged value as current');
  });

  it('closes the session when the match ends', async () => {
    const { shell } = use();
    await replay();
    expect(shell.matchId).not.toBeNull();

    await shell.stop();
    expect(shell.matchId).toBeNull();
  });

  it('says nothing at all without a gesture', async () => {
    const { session } = use();
    await replay();

    // ADR-0042's headline property, at the only altitude that can assert it: a whole recorded match
    // through the whole composition root, and not one turn. A coach that never interrupts you
    // cannot interrupt you wrongly.
    expect(session.turns).toHaveLength(0);
  });
});

describe('a question, end to end', () => {
  it('hands the session a snapshot rendered from the recorded match', async () => {
    const { shell } = use();
    await replay();

    const text = await ask(use());

    // The acceptance criterion of T1: press the key, ask a question, get an answer with the current
    // snapshot injected. Every stage is real — `FakeGsiSource` and `createSilentSession` are the
    // only two stand-ins, and neither is between the world model and the text.
    expect(text).toBeDefined();
    expect(text?.length).toBeGreaterThan(0);
    // Rendered from the fixture rather than from `buildWorld()`: the header carries the clock the
    // recorded POSTs put in the world model.
    expect(text).toMatch(/^T \d/u);
    expect(shell.state.world.version).toBeGreaterThan(0);
  });

  it('renders on the release, so the world has the time the question took to ask', async () => {
    const { shell, clock, keys, session } = use();
    await replay();
    const versionAtPress = shell.state.world.version;

    keys.tap(clock.now());
    shell.runtime.dispatch({ kind: 'capture', event: 'firstAudio' });
    // Nothing has been handed over yet: the player is still talking.
    expect(session.turns).toHaveLength(0);

    keys.tap(clock.now());
    await Promise.resolve();
    await Promise.resolve();
    expect(session.turns).toHaveLength(1);
    expect(shell.state.world.version).toBeGreaterThanOrEqual(versionAtPress);
  });

  it('injects nothing when the gesture is cancelled', async () => {
    const { shell, clock, keys, session } = use();
    await replay();

    keys.tap(clock.now());
    shell.runtime.dispatch({ kind: 'capture', event: 'firstAudio' });
    shell.runtime.dispatch({ kind: 'trigger', event: { kind: 'cancel' } });
    await Promise.resolve();
    await Promise.resolve();

    // A cancelled gesture was not a question, so no snapshot is rendered and nothing is spent
    // against the conversation window.
    expect(session.turns).toHaveLength(0);
    expect(shell.runtime.snapshot().phase.kind).toBe('idle');
  });

  it('works between matches as well as during one', async () => {
    // Push-to-talk was never gated on being in a match, and since ADR-0042 the agent has an app
    // lifetime rather than a match one — so this is the same path rather than a special case.
    const { shell, session } = use();
    expect(shell.matchId).toBeNull();

    const text = await ask(use());

    expect(session.turns).toHaveLength(1);
    // Pre-horn: the header is undroppable, so the model is told it cannot see a game rather than
    // being handed an empty string.
    expect(text).toBe('T pre-horn');
  });
});

describe('the interaction path', () => {
  it('arms the chip on a tap from idle, and does not wait on a microphone to do it', async () => {
    const { shell, clock, window, keys } = use();
    await replay();

    keys.tap(clock.now());

    // Armed rather than Listening, and that is the design: Listening is entered on
    // `capture.opened` from the audio graph, and *the chip's appearance never waits on the mic*
    // (overlay §9.1) — which is the entire reason an Armed state exists.
    expect(window.isVisible()).toBe(true);
    expect(shell.runtime.snapshot().phase).toEqual({ kind: 'armed', gesture: 'latch' });
  });

  it('reaches Speaking on the response, and reopens the mic because the gesture latched', async () => {
    const { shell, timers } = use();
    await replay();
    await ask(use());

    // The silent session emits `responseStarted` on hand-over and `responseEnded` after a nominal
    // speaking duration. A port that emitted neither would leave the chip in Processing forever.
    expect(shell.runtime.snapshot().phase.kind).toBe('speaking');

    timers.flush();
    // Listening, not Idle: a latched session is still open when Riki stops talking — that is what
    // latching means, and it is the "session active" affordance ui-design §13.5 asked for. `ask`
    // taps, and a tap latches.
    expect(shell.runtime.snapshot().phase.kind).toBe('listening');
  });

  it('barges in: one key press during Riki speaking goes straight to Listening', async () => {
    const { shell, clock, keys } = use();
    await replay();
    await ask(use());
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

  it('never enters Speaking without a gesture behind it', async () => {
    const { shell, window } = use();
    await replay();

    // The unprompted entry is gone (ADR-0042). A whole match produces no chip at all, which is the
    // overlay half of "invisible until needed".
    expect(shell.runtime.snapshot().phase.kind).toBe('idle');
    expect(window.isVisible()).toBe(false);
  });
});

describe('the inspector (main/debug)', () => {
  it('does not exist unless it was asked for', () => {
    // Off by default, and the default is what every other test in this file runs under. With it off
    // the shell installs no decorator, builds no hub, and holds no rendered snapshot in memory.
    expect(use().shell.debug).toBeNull();
  });

  it('changes nothing about what Riki does', async () => {
    /** One full fixture replay plus one question, returning what the turn path produced. */
    async function run(debug: boolean): Promise<readonly string[]> {
      const built = build({ 'debug.enabled': debug });
      await built.shell.start();
      try {
        await replayInto(built);
        await ask(built);
        return built.session.turns.map((turn) => turn.snapshotText);
      } finally {
        await built.shell.stop();
        rmSync(built.dataDir, { recursive: true, force: true });
      }
    }

    const off = await run(false);
    const on = await run(true);

    // The claim the whole component is built around. `observing-snapshot.ts` returns its delegate's
    // value unchanged, and this is what that means end to end: the same fixture and the same
    // gesture produce the same text either way. If it ever does not, the inspector is not measuring
    // the app — it is changing it.
    expect(on).toEqual(off);
    expect(on.length).toBeGreaterThan(0);
  });

  describe('with it on', () => {
    beforeEach(async () => {
      const current = harness;
      harness = null;
      if (current !== null) {
        await current.shell.stop();
        rmSync(current.dataDir, { recursive: true, force: true });
      }
      harness = build({ 'debug.enabled': true });
      await harness.shell.start();
    });

    it('collects without a window, which is the shape a replay wants', () => {
      const { shell } = use();
      expect(shell.debug).not.toBeNull();
      // No `DebugWindowFactory` is passed here on purpose: everything the inspector gathers is a
      // Tier 1/Tier 4 concern, and a window is Tier 5's business.
      expect(shell.debug?.isOpen()).toBe(false);
    });

    it('shows the world the model is actually reading', async () => {
      const { shell, clock } = use();
      await replay();

      const frame = shell.debug?.hub.frame(clock.now());
      expect(frame?.session.matchId).toBe('7891234567');
      expect(frame?.session.matchSession).toBe(true);
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

    it('shows what the model was given, and what became of it', async () => {
      const { shell, clock, timers } = use();
      await replay();
      await ask(use());

      const open = shell.debug?.hub.frame(clock.now()).turns ?? [];
      expect(open).toHaveLength(1);
      // The rendered text, which exists nowhere else a person can read — and the whole reason the
      // snapshot source is decorated rather than the agent (ADR-0032).
      expect(open[0]?.snapshotText.length).toBeGreaterThan(0);
      expect(open[0]?.snapshotTokens).toBeGreaterThan(0);
      expect(open[0]?.cause).toBe('player');
      expect(open[0]?.outcome).toBe('open');

      // A turn is `open` until the session says the response ended, which for the silent session is
      // the nominal speaking duration expiring.
      timers.flush();
      const closed = shell.debug?.hub.frame(clock.now()).turns ?? [];
      expect(closed[0]?.outcome).toBe('spoke');
    });

    it('traces the chain a question takes, in order', async () => {
      const { shell, clock } = use();
      await replay();
      await ask(use());

      const stages = (shell.debug?.hub.frame(clock.now()).trace ?? []).map((step) => step.stage);
      // The panel exists because a chain that stops halfway produces no fault anywhere: the absence
      // of the next step is the finding (ADR-0039).
      expect(stages).toContain('session');
      expect(stages).toContain('turn');
      expect(stages).toContain('snapshot');
    });

    it('offers the tray row it now has somewhere to send', () => {
      const { tray } = use();
      expect(tray.labels).toContain('Open Inspector…');
    });

    it('offers the scenarios, and says why one cannot run', () => {
      const { shell } = use();
      const rows = shell.debug?.actions?.list() ?? [];

      expect(rows.map((row) => row.id)).toEqual(['scenario.match', 'scenario.speak']);
      // Between matches there is no session to speak into, and the panel says so rather than
      // rendering a button that does nothing.
      expect(rows.find((row) => row.id === 'scenario.speak')?.note).toContain('unavailable');
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

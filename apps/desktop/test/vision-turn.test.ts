/**
 * Tier 4: the vision leg of the loop, end to end, on a machine with no capture backend.
 *
 * `shell.test.ts` drives the same composition root from `fixtures/gsi/`, and everything it asserts
 * is reachable from GSI alone. This file exists because one edge of the loop is not:
 * `enemies[].position` has exactly one source and it is computer vision (GSI cannot see an enemy,
 * and §8.2 fairness allows only what the minimap renders — state-capture-architecture.md §5.3). So
 * *"where is their mid"*, the question `dota2` §6.2 says matters most, could never be answered in
 * any test, on any machine, in either language.
 *
 * What makes it runnable here is `FakeVisionSidecar` standing in as the `ChildProcessPort`.
 * Everything above that seam is production code: `createSidecarSource` supervises it,
 * `createProtocolCodec` does the handshake and the two-clock arithmetic, the observation bus
 * carries the result, `packages/world-model` fuses it under the real confidence and precedence
 * gates, and `packages/context` renders it into the text a turn is answered from. No Dota, no GPU,
 * no Mac.
 *
 * The negative control in the third block is the load-bearing half of the file: the same fixture,
 * the same shell, the vision source simply never cranked, and no enemy position in the snapshot.
 * Without it an assertion that one appeared proves only that *something* was rendered.
 *
 * It was `vision-coaching.test.ts` until ADR-0042. What it proved then was that a CV fact survived
 * thirteen gates into an unprompted coaching turn; what it proves now is that the same fact reaches
 * the model when the player asks. The seam under test is identical and the claim is the one that
 * outlives the coach.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { ConfigLayer } from '@riki/config';
import type { Timers } from '@riki/context';
import { createMatchSessionTracker, type MatchLifecycleEvent } from '@riki/gsi';
import { createFakeGsiSource, parseGsiFixture, type FakeGsiSource } from '@riki/gsi/testing';
import {
  createFakeVisionSidecar,
  loadVisionFixture,
  sightings,
  type FakeVisionSidecar,
  type VisionScript,
} from '@riki/protocol/testing';
import type { MonoMs, Observation, SourceHealth } from '@riki/world-model';

import type { Millis } from '../src/shared/overlay.js';
import { createFakeWindow, fakeWindowFactory } from '../src/main/testing/fakes.js';
import type { Clock as UiClock } from '../src/main/session/contracts.js';
import type { TimerId } from '../src/main/session/types.js';
import { NO_RESTART, type SourceRegistration } from '../src/main/state/index.js';
import type { TrayAction, TraySurface } from '../src/main/tray/index.js';
import type { KeySource } from '../src/main/trigger/index.js';
import { createRikiShell, resolveShellConfig, type RikiShell } from '../src/main/shell/index.js';
import { createSilentSession, type SilentSession } from '../src/main/shell/silent-session.js';

const GSI_FIXTURE = 'fixtures/gsi/laning-phase.jsonl';
const VISION_FIXTURE = fileURLToPath(
  new URL('../../../fixtures/vision/enemy-rotation.jsonl', import.meta.url),
);

const GSI_LINES = parseGsiFixture(readFileSync(GSI_FIXTURE, 'utf8'));

/** The recorded gap after line `index`, so game time and wall time advance together. */
function gapAfter(index: number): Millis {
  const current = GSI_LINES[index];
  const next = GSI_LINES[index + 1];
  if (current === undefined || next === undefined) return 0;
  return Math.max(0, next.atMs - current.atMs);
}

/** Five enemies on the minimap, once. After this they are simply never reported again. */
const ENEMIES = [
  { hero: 'npc_dota_hero_nevermore', at: { x: 0.72, y: 0.3 }, confidence: 0.93 },
  { hero: 'npc_dota_hero_tidehunter', at: { x: 0.66, y: 0.24 }, confidence: 0.88 },
  { hero: 'npc_dota_hero_axe', at: { x: 0.34, y: 0.7 }, confidence: 0.91 },
  { hero: 'npc_dota_hero_lion', at: { x: 0.3, y: 0.74 }, confidence: 0.86 },
  // Under the 0.5 confidence gate on every pass, so the world model should never learn this one.
  { hero: 'npc_dota_hero_crystal_maiden', at: { x: 0.55, y: 0.45 }, confidence: 0.4 },
] as const;

function twoPasses(): VisionScript {
  return {
    steps: [0, 200].map((atMs) =>
      sightings({
        atMs,
        heroes: ENEMIES.map((enemy) => ({ ...enemy, side: 'enemies' as const })),
        digest: { hash: '9e3779b97f4a7c15', changed: true },
      }),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// The ports the shell needs, at their smallest
// ---------------------------------------------------------------------------------------------

interface TestClock extends UiClock {
  advance(byMs: Millis): void;
}

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
  flush(): number;
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
  };
}

function silentTray(): TraySurface {
  const actions = new Set<(action: TrayAction) => void>();
  return {
    render: () => undefined,
    onAction(listener) {
      actions.add(listener);
      return () => actions.delete(listener);
    },
    destroy: () => undefined,
  };
}

function silentKeys(): KeySource {
  return {
    hasKeyUp: true,
    bind: () => true,
    unbind: () => undefined,
    onKeyDown: () => () => undefined,
    onKeyUp: () => () => undefined,
    onCancel: () => () => undefined,
  };
}

// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly shell: RikiShell;
  readonly gsi: FakeGsiSource;
  readonly vision: FakeVisionSidecar;
  readonly session: SilentSession;
  readonly clock: TestClock;
  readonly timers: TestTimers;
  readonly dataDir: string;
}

const built: Harness[] = [];

function build(script: VisionScript, extra: ConfigLayer = {}): Harness {
  const clock = testClock();
  const timers = testTimers();
  const dataDir = mkdtempSync(join(tmpdir(), 'riki-vision-'));
  const worldClock = { now: (): MonoMs => clock.now() as MonoMs };

  const gsi = createFakeGsiSource({ lines: GSI_LINES, clock: worldClock });
  const session = createSilentSession({ clock: worldClock, timers });

  // `speed: 0` — the crank, not the timer. A test that waited out a recorded 200 ms capture
  // interval per pass would take longer than the match it is replaying.
  const vision = createFakeVisionSidecar({ script });

  const shell = createRikiShell({
    config: resolveShellConfig({
      dataDir,
      gsiToken: 'test-token',
      layer: {
        'vision.enabled': true,
        // The flag under test. No `vision.binaryPath` anywhere in this file — that is the point:
        // there is no binary, and there is no machine here that could run one.
        'vision.fake': true,
        ...extra,
      },
    }),
    clock,
    timers,
    platform: 'darwin',
    // The seam. Everything between here and the world model is production code.
    processes: vision,
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
        // `FakeGsiSource` has no `onLifecycle`; `shell.test.ts`'s header explains the workaround
        // and why it is deliberately visible rather than tidy.
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
    windowFactory: fakeWindowFactory(createFakeWindow()),
    tray: silentTray(),
    keys: silentKeys(),
    session,
  });

  const harness = { shell, gsi, vision, session, clock, timers, dataDir };
  built.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of built.splice(0)) {
    await harness.shell.stop();
    rmSync(harness.dataDir, { recursive: true, force: true });
  }
});

/** Replay GSI lines until `until` says stop, or the recording runs out. Returns where it got to. */
async function replayGsi(
  harness: Harness,
  from: number,
  until: () => boolean = () => false,
): Promise<number> {
  let index = from;
  for (; ; index += 1) {
    if (until()) break;
    if (!harness.gsi.step()) break;
    harness.clock.advance(gapAfter(index));
    await Promise.resolve();
  }
  await Promise.resolve();
  return index;
}

/**
 * One push-to-talk turn, and the text it was answered from.
 *
 * Through the agent rather than through the renderer, because what is under test is the chain from
 * the sidecar to the model: the gesture's own wiring is `shell.test.ts`'s.
 */
async function askAndRead(harness: Harness): Promise<string> {
  const turnId = harness.shell.agent.beginPlayerTurn('push');
  await harness.shell.agent.endPlayerTurn(turnId, 'release');
  return harness.session.turns.at(-1)?.snapshotText ?? '';
}

/**
 * Start, run the match up to the point a session exists, then show the sidecar the map.
 *
 * The order matters and is the order a real session has: the sidecar is spawned by `shell.start()`
 * and is already handshaken and capturing before the first POST arrives, but its facts are only
 * *interesting* once there is a match and a game clock to age them against.
 */
async function upToFirstSighting(harness: Harness): Promise<number> {
  await harness.shell.start();
  const index = await replayGsi(harness, 0, () => harness.shell.matchId !== null);
  harness.vision.drain();
  await Promise.resolve();
  return index;
}

// ---------------------------------------------------------------------------------------------

describe('the sidecar the app spawned', () => {
  it('is spawned, handshaken and capturing without a binary on disk', async () => {
    const harness = build(twoPasses());
    await harness.shell.start();

    // `vision.fake` alone got here: no `vision.binaryPath` is set anywhere in this file, and
    // before this change the shell refused to register the source without one.
    const stats = harness.vision.stats();
    expect(stats.spawns).toBe(1);
    expect(stats.handshakes).toBe(1);
    expect(stats.commands.map((command) => command.type)).toStrictEqual([
      'hello',
      'capture.configure',
      'capture.start',
    ]);
    // And it was asked for a window, never a screen — the app's real `DEFAULT_CAPTURE_CONFIG`.
    expect(Object.keys(stats.captureConfig?.target ?? {}).sort()).toStrictEqual([
      'processName',
      'titleContains',
    ]);
    expect(harness.vision.capturing).toBe(true);
  });

  it('is reported as a source of the state subsystem, and goes live once it talks', async () => {
    const harness = build(twoPasses());
    await harness.shell.start();

    const sidecarState = (): string | undefined =>
      harness.shell.state
        .health(harness.clock.now() as MonoMs)
        .sources.find((source) => source.id === 'sidecar')?.health.state;

    expect(sidecarState()).toBe('starting');
    harness.vision.step();
    expect(sidecarState()).toBe('live');
  });
});

describe('a minimap sighting, all the way into the world model', () => {
  it('writes enemies[].position, tagged cv, which no other source could have written', async () => {
    const harness = build(twoPasses());
    await upToFirstSighting(harness);

    const world = harness.shell.state.world.snapshot(harness.clock.now() as MonoMs);
    const heroes = world.enemies().map((view) => String(view.hero));
    expect(heroes).toContain('npc_dota_hero_nevermore');

    const position = world.enemies().find((view) => String(view.hero) === 'npc_dota_hero_nevermore')
      ?.state.position;
    expect(position?.source).toBe('cv');
    expect(position?.confidence).toBeCloseTo(0.93);
    // Dota world units, not the 0..1 the wire carries — otherwise every enemy sits within one unit
    // of the origin and `nearbyEnemies` returns the whole team forever.
    expect(Math.abs(position?.value.x ?? 0)).toBeGreaterThan(1_000);
  });

  it('drops the sighting the confidence gate refuses, rather than softening it', async () => {
    const harness = build(twoPasses());
    await upToFirstSighting(harness);

    const world = harness.shell.state.world.snapshot(harness.clock.now() as MonoMs);
    // 0.4 against a 0.5 floor. dota2 §4 rule 3: silence beats a confident hallucination, and the
    // renderer is the layer least able to make that call.
    expect(world.enemies().map((view) => String(view.hero))).not.toContain(
      'npc_dota_hero_crystal_maiden',
    );
  });
});

describe('vision reaching the model', () => {
  it('puts the enemy team in the text a question is answered from, once vision has seen them', async () => {
    const harness = build(twoPasses());
    const index = await upToFirstSighting(harness);

    // Nothing reports those heroes again, and `*.*.position` ages in *game* time — so the GSI clock
    // advancing is what turns a sighting into a claim about where somebody *was*.
    await replayGsi(harness, index);
    const text = await askAndRead(harness);

    // The assertion the loop has never been able to make: a line in the ~300 tokens the model reads
    // that **only** computer vision could have produced. `unseenFor` excludes a hero that was never
    // observed at all — precisely so "we cannot see the map" does not become "they are all missing"
    // — so this line existing at all means a CV fact went in and came out the far end.
    expect(text).toContain('unseen >20s');
    expect(text).toContain('npc_dota_hero_nevermore');
  });

  it('says nothing about the enemy team without the sidecar — the negative control', async () => {
    // The same fixture and the same shell, with the crank never turned. `unseen >20s` here would
    // mean something other than vision had written a position, which is the failure the whole
    // provenance layer exists to make impossible.
    const harness = build(twoPasses());
    await harness.shell.start();
    await replayGsi(harness, 0);

    const text = await askAndRead(harness);

    expect(harness.vision.stats().spawns).toBe(1);
    expect(text).not.toContain('unseen >20s');
  });

  it('does not yet name *where* an enemy was, and that gap is the adapter\u2019s', async () => {
    // ⚠ Deliberately asserting an absence. `enemies.*.area` is one of the five paths
    // `main/agent/world-view.ts` leaves unsatisfied — turning a `MapPosition` into `top`/`mid`/
    // `rosh` needs a map-region table that belongs with the sidecar, which already speaks in
    // regions. So the `seen:` line has no data and the world model holds a position the model never
    // sees.
    //
    // Before ADR-0042 that gap was invisible here, because the trigger engine read positions
    // straight off the world model rather than out of the snapshot. It is the *first* thing
    // conversational-architecture.md §4's `enemy(hero?)` tool has to close, and this is where the
    // day it does will show up as a failing test.
    const harness = build(twoPasses());
    await upToFirstSighting(harness);

    const world = harness.shell.state.world.snapshot(harness.clock.now() as MonoMs);
    const position = world.enemies().find((view) => String(view.hero) === 'npc_dota_hero_nevermore')
      ?.state.position;
    expect(position).toBeDefined();

    expect(await askAndRead(harness)).not.toContain('seen:');
  });
});

describe('the committed fixture, through the whole shell', () => {
  it('replays, reports its problem, and gets restarted after it panics', async () => {
    const harness = build(loadVisionFixture(VISION_FIXTURE));
    await harness.shell.start();
    await replayGsi(harness, 0, () => harness.shell.matchId !== null);

    harness.vision.drain();
    await Promise.resolve();

    // The whole script ran, including the `exclusive_fullscreen` problem and the stderr line, and
    // ended in a panic — which the supervisor answers with a restart on a backoff timer.
    expect(harness.vision.stats().spawns).toBe(1);
    harness.timers.flush();
    expect(harness.vision.stats().spawns).toBe(2);
    // The second process did its own handshake. A supervisor that reconnected without one would
    // have a sidecar that refuses every command it sends.
    expect(harness.vision.stats().handshakes).toBe(2);
  });
});

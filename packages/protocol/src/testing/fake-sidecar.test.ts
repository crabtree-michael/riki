/**
 * Tier 1 for the fake itself.
 *
 * A fake nobody tests is a fake that agrees with whatever the code under test happens to do, which
 * is worse than no fake at all — every consumer inherits its bugs as passing assertions. So this
 * file drives `FakeVisionSidecar` directly, through the same `ChildProcessPort` surface Electron
 * main uses, and asserts the four behaviours the rest of the repo relies on: the handshake gate,
 * the script, dying, and being spawned again afterwards.
 *
 * What it deliberately does *not* assert is anything about what the app does with the output —
 * `apps/desktop` owns that, and a fake that tested its consumer would be testing itself twice.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, commands, decodeSidecarEvent, type SidecarEvent } from '../index.js';
import { createFakeVisionSidecar, type FakeProcessHandle } from './fake-sidecar.js';
import { defaultVisionScript, parseVisionFixture, sightings } from './vision-script.js';

const APP = { name: 'riki-desktop', build: 'test' };

const FIXTURE = fileURLToPath(
  new URL('../../../../fixtures/vision/enemy-rotation.jsonl', import.meta.url),
);

/** A two-pass script: enough to have a beginning, a middle and an end. */
function script() {
  return {
    steps: [
      sightings({
        atMs: 0,
        heroes: [{ hero: 'npc_dota_hero_lion', side: 'enemies' as const, at: { x: 0.3, y: 0.7 } }],
      }),
      sightings({
        atMs: 200,
        heroes: [{ hero: 'npc_dota_hero_axe', side: 'enemies' as const, at: { x: 0.4, y: 0.6 } }],
      }),
    ],
  };
}

/** Spawn, and collect everything the process says. */
function spawned(sidecar: ReturnType<typeof createFakeVisionSidecar>) {
  const handle: FakeProcessHandle = sidecar.spawn({ command: 'fake', args: [] });
  const events: SidecarEvent[] = [];
  const stderr: string[] = [];
  const exits: string[] = [];

  handle.onStdout((line) => {
    const decoded = decodeSidecarEvent(line);
    if (!decoded.ok) throw new Error(`the fake wrote a line it cannot read back: ${line}`);
    events.push(decoded.event);
  });
  handle.onStderr((line) => stderr.push(line));
  handle.onExit((reason) => exits.push(reason));

  return { handle, events, stderr, exits };
}

/** The app's own opening lines, so tests do not hand-write the handshake. */
function handshake(handle: FakeProcessHandle): void {
  handle.write(JSON.stringify(commands.hello(APP)));
  handle.write(
    JSON.stringify(
      commands.configure({
        target: { processName: 'dota2', titleContains: 'Dota 2' },
        regions: [{ id: 'minimap', rect: { x: 0, y: 0.755, w: 0.155, h: 0.245 } }],
        intervalMs: 200,
      }),
    ),
  );
  handle.write(JSON.stringify(commands.start()));
}

describe('the handshake gate', () => {
  it('answers hello with ready, naming the backend', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle, events } = spawned(sidecar);

    handle.write(JSON.stringify(commands.hello(APP)));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ready', sidecar: { backendAvailable: true } });
  });

  it('refuses a command that arrives before hello, and does not act on it', () => {
    // The rule `crates/riki-ipc/src/handshake.rs` enforces: a `capture.start` from a build that
    // never introduced itself is a build whose idea of `CaptureConfig` we have no reason to trust.
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle, events } = spawned(sidecar);

    handle.write(JSON.stringify(commands.start()));

    expect(events[0]).toMatchObject({ type: 'problem', problem: { kind: 'handshake_required' } });
    expect(sidecar.capturing).toBe(false);
    expect(sidecar.step()).toBe(false);
  });

  it('answers a second hello rather than complaining about it', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle, events } = spawned(sidecar);

    handle.write(JSON.stringify(commands.hello(APP)));
    handle.write(JSON.stringify(commands.hello(APP)));

    expect(events.map((event) => event.type)).toStrictEqual(['ready', 'ready']);
    expect(sidecar.stats().handshakes).toBe(2);
  });

  it('treats a version it does not speak as fatal, and exits', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle, events, exits } = spawned(sidecar);

    handle.write(JSON.stringify({ v: PROTOCOL_VERSION + 1, type: 'hello', app: APP }));

    expect(events[0]).toMatchObject({
      type: 'problem',
      problem: { kind: 'protocol_version_mismatch', fatal: true },
    });
    expect(exits).toStrictEqual(['exited with code 2']);
  });

  it('reports a line it cannot parse and keeps running', () => {
    // Never fatal. Exiting on one bad line turns a cosmetic bug in the app into a restart loop
    // that also loses capture.
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle, events, exits } = spawned(sidecar);

    handle.write('{ not json');

    expect(events[0]).toMatchObject({ type: 'problem', problem: { kind: 'malformed_message' } });
    expect(exits).toStrictEqual([]);
    expect(sidecar.stats().undecodableCommands).toBe(1);
  });

  it('records the capture configuration the app asked for', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle } = spawned(sidecar);
    handshake(handle);

    expect(sidecar.stats().captureConfig?.regions.map((region) => region.id)).toStrictEqual([
      'minimap',
    ]);
    expect(sidecar.stats().commands.map((command) => command.type)).toStrictEqual([
      'hello',
      'capture.configure',
      'capture.start',
    ]);
  });
});

describe('the script', () => {
  it('emits nothing until capture.start, and one pass per step after it', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle, events } = spawned(sidecar);

    handle.write(JSON.stringify(commands.hello(APP)));
    expect(sidecar.step()).toBe(false);

    handle.write(JSON.stringify(commands.start()));
    expect(sidecar.step()).toBe(true);
    expect(events.filter((event) => event.type === 'cv.detections')).toHaveLength(1);
  });

  it('runs out, and says so', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle } = spawned(sidecar);
    handshake(handle);

    expect(sidecar.drain()).toBe(2);
    expect(sidecar.remaining).toBe(0);
    expect(sidecar.step()).toBe(false);
  });

  it('starts over when it is asked to loop', () => {
    // A sidecar that goes permanently silent after two seconds is one the health poll reports as
    // degraded for the rest of a session, which is not what `pnpm dev` with a fake wants.
    const sidecar = createFakeVisionSidecar({ script: script(), loop: true });
    const { handle, events } = spawned(sidecar);
    handshake(handle);

    for (let i = 0; i < 5; i += 1) expect(sidecar.step()).toBe(true);
    expect(events.filter((event) => event.type === 'cv.detections')).toHaveLength(5);
  });

  it('stops emitting after capture.stop', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle } = spawned(sidecar);
    handshake(handle);
    handle.write(JSON.stringify(commands.stop()));

    expect(sidecar.capturing).toBe(false);
    expect(sidecar.step()).toBe(false);
  });
});

describe('dying', () => {
  it('exits on a scripted crash, with the reason the supervisor sees', () => {
    const sidecar = createFakeVisionSidecar({
      script: { steps: [{ atMs: 0, exit: 'exited with code 101' }] },
    });
    const { handle, exits } = spawned(sidecar);
    handshake(handle);

    expect(sidecar.step()).toBe(true);
    expect(exits).toStrictEqual(['exited with code 101']);
    // Everything after death is inert, exactly as a closed pipe is. A write that threw would be a
    // failure mode real code cannot produce.
    expect(() => {
      handle.write(JSON.stringify(commands.start()));
    }).not.toThrow();
    expect(sidecar.capturing).toBe(false);
  });

  it('exits on shutdown, cleanly', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle, exits } = spawned(sidecar);
    handshake(handle);
    handle.write(JSON.stringify(commands.shutdown()));

    expect(exits).toStrictEqual(['exited with code 0']);
  });

  it('answers kill once, and only once', () => {
    const sidecar = createFakeVisionSidecar({ script: script() });
    const { handle, exits } = spawned(sidecar);
    handshake(handle);

    void handle.kill();
    void handle.kill();
    expect(exits).toStrictEqual(['killed by SIGTERM']);
  });

  it('can be spawned again, from the top, and counts the spawns', () => {
    // What the supervisor does after a crash. The second process has its own handshake state —
    // a fake that remembered the first one would make `hello`-on-every-spawn look optional.
    const sidecar = createFakeVisionSidecar({ script: script() });
    const first = spawned(sidecar);
    handshake(first.handle);
    sidecar.drain();

    const second = spawned(sidecar);
    expect(sidecar.step()).toBe(false);
    handshake(second.handle);
    expect(sidecar.step()).toBe(true);

    expect(sidecar.stats().spawns).toBe(2);
    // The first process is gone; nothing reaches its listeners any more.
    expect(second.events.filter((event) => event.type === 'cv.detections')).toHaveLength(1);
    expect(first.events.filter((event) => event.type === 'cv.detections')).toHaveLength(2);
  });
});

describe('the committed fixture', () => {
  const parsed = parseVisionFixture(readFileSync(FIXTURE, 'utf8'));

  it('parses, skipping the header', () => {
    expect(parsed.steps.length).toBeGreaterThan(5);
    expect(parsed.steps[0]?.atMs).toBe(0);
  });

  it('replays as protocol the app can read, including its problem, stderr and crash', () => {
    const sidecar = createFakeVisionSidecar({ script: parsed });
    const { handle, events, stderr, exits } = spawned(sidecar);
    handshake(handle);
    sidecar.drain();

    // `spawned` throws on a line that does not decode, so reaching here at all is the assertion
    // that every scripted event is valid protocol of the current version.
    expect(events.filter((event) => event.type === 'cv.detections').length).toBeGreaterThan(3);
    expect(events.some((event) => event.type === 'problem')).toBe(true);
    expect(stderr).toHaveLength(1);
    expect(exits).toStrictEqual(['exited with code 101']);
  });
});

describe('the built-in script', () => {
  it('stops reporting two heroes partway through, without saying so', () => {
    // There is no "I cannot see them" message in the protocol and there should not be. Absence of
    // a sighting is the signal; ageing is what turns it into `enemy_missing`.
    const built = defaultVisionScript({ rotateAtMs: 1_000, durationMs: 2_000 });
    const heroesAt = (atMs: number): readonly string[] => {
      const step = built.steps.find((candidate) => candidate.atMs === atMs);
      if (step === undefined || !('event' in step) || step.event.type !== 'cv.detections') {
        throw new Error(`no detections at ${String(atMs)}ms`);
      }
      return step.event.facts.flatMap((fact) =>
        fact.payload.kind === 'minimap.hero' ? [fact.payload.hero] : [],
      );
    };

    expect(heroesAt(800)).toContain('npc_dota_hero_nevermore');
    expect(heroesAt(1_200)).not.toContain('npc_dota_hero_nevermore');
    expect(heroesAt(1_200)).toContain('npc_dota_hero_axe');
  });

  it('keeps one hero under the confidence gate on every pass', () => {
    const built = defaultVisionScript({ durationMs: 1_000 });
    const weak = built.steps.flatMap((step) =>
      'event' in step && step.event.type === 'cv.detections'
        ? step.event.facts.filter((fact) => fact.confidence < 0.5)
        : [],
    );
    expect(weak.length).toBeGreaterThan(3);
  });
});

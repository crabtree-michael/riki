/**
 * Tier 1. §10's row for this package is "temp file: rotate, truncate, partial line,
 * start-mid-file", and those four are the reason the tailer exists — everything else here is a
 * regex over a format we do not control.
 *
 * The tailer tests drive `poll()` by hand rather than waiting out the 250 ms timer. A test that
 * sleeps is a test that is flaky on a loaded machine and slow on an idle one.
 */

import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, LogEvent, MonoMs, Observation } from './contracts.js';
import { defaultMatchers, matchLine, stripLogPrefix } from './matchers/index.js';
import { mayEgress, privacyOf } from './privacy.js';
import { createConsoleLogTailer } from './tailer.js';

const at = { observedAt: 0 as MonoMs, atGameClock: null };
const matchers = defaultMatchers();
const match = (line: string): LogEvent | null => matchLine(matchers, line, at);

const clock: Clock = { now: () => 0 as MonoMs };

describe('matchers', () => {
  it('reads the chat forms the matcher was written against', () => {
    expect(match('[All Chat] SomePlayer: gg go next')).toEqual({
      kind: 'chat',
      text: 'gg go next',
      speaker: 'SomePlayer',
      channel: 'all',
      privacy: 'sensitive',
    });
    expect(match('[Team Chat] Another Player: mid is missing')).toMatchObject({
      channel: 'team',
      text: 'mid is missing',
    });
    expect(match('Third Player says: rosh in 2')).toMatchObject({
      kind: 'chat',
      text: 'rosh in 2',
    });
  });

  it('strips a log timestamp before matching, in one place rather than per pattern', () => {
    expect(stripLogPrefix('[00:12] npc_dota_hero_riki bought item_tango')).toBe(
      'npc_dota_hero_riki bought item_tango',
    );
    expect(match('[12:04] [All Chat] SomePlayer: hi')).toMatchObject({ text: 'hi' });
  });

  it('gets a passive-voice kill the right way round', () => {
    // `killed by` also matches the active pattern with the roles reversed, which would put the
    // wrong hero on a respawn timer.
    expect(match('npc_dota_hero_riki was killed by npc_dota_hero_axe')).toEqual({
      kind: 'kill',
      killer: 'npc_dota_hero_axe',
      victim: 'npc_dota_hero_riki',
      privacy: 'public',
    });
    expect(match('npc_dota_hero_pudge killed npc_dota_hero_lina')).toMatchObject({
      killer: 'npc_dota_hero_pudge',
      victim: 'npc_dota_hero_lina',
    });
  });

  it('handles a death with no killer', () => {
    expect(match('npc_dota_hero_zuus died')).toMatchObject({
      victim: 'npc_dota_hero_zuus',
      killer: undefined,
    });
  });

  it('matches nothing against engine noise, which is most of the file', () => {
    expect(match("CParticleMgr::LoadParticleFile: unable to load 'particles/foo.vpcf'")).toBeNull();
    expect(match('Initializing Steam libraries for secure Internet server')).toBeNull();
    expect(match('')).toBeNull();
  });

  it('recognises every line of the fixture that is meant to be recognised', async () => {
    const contents = await readFile('fixtures/console-log/chat-and-events.log', 'utf8');
    const events = contents
      .split('\n')
      .filter((line) => line !== '')
      .map(match)
      .filter((event): event is LogEvent => event !== null);

    expect(events.filter((e) => e.kind === 'chat')).toHaveLength(4);
    expect(events.filter((e) => e.kind === 'kill')).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'ping')).toHaveLength(2);
  });
});

describe('privacy', () => {
  it('classifies typed chat as sensitive and game events as public', () => {
    // Other people's words versus a description of the game every player already saw.
    expect(
      privacyOf({ kind: 'chat', text: 'gg', speaker: 'a', channel: 'all', privacy: 'sensitive' }),
    ).toBe('sensitive');
    expect(privacyOf({ kind: 'kill', killer: 'a', victim: 'b', privacy: 'public' })).toBe('public');
  });

  it('blocks chat egress by default, because this failure cannot be walked back', () => {
    const chat: LogEvent = {
      kind: 'chat',
      text: 'gg',
      speaker: 'a',
      channel: 'all',
      privacy: 'sensitive',
    };
    expect(mayEgress(chat)).toBe(false);
    expect(mayEgress(chat, true)).toBe(true);
    expect(mayEgress({ kind: 'ping', kind_detail: 'Missing', privacy: 'public' })).toBe(true);
  });
});

describe('ConsoleLogTailer', () => {
  let dir = '';
  let path = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'riki-log-'));
    path = join(dir, 'console.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tail = (fromStart = true) => {
    const seen: Observation[] = [];
    const tailer = createConsoleLogTailer({ path, matchers, clock, pollMs: 250, fromStart });
    tailer.subscribe((o) => seen.push(o));
    return { tailer, seen };
  };

  it('seeks to the end by default, so starting mid-match does not replay the match', async () => {
    await writeFile(path, '[All Chat] Old: from an hour ago\n');
    const { tailer, seen } = tail(false);
    await tailer.start();
    await tailer.stop();

    expect(seen).toEqual([]);

    await writeFile(path, '[All Chat] Old: from an hour ago\n[All Chat] New: just now\n');
    await tailer.poll();
    expect(seen).toHaveLength(1);
    expect((seen[0]?.payload as { text: string }).text).toBe('just now');
  });

  it('holds back a partial trailing line until its newline arrives', async () => {
    // A poll can land mid-write, and half a chat line parses as a whole one.
    await writeFile(path, '[All Chat] Someone: half a li');
    const { tailer, seen } = tail();
    await tailer.start();
    expect(seen).toEqual([]);

    await writeFile(path, '[All Chat] Someone: half a line and the rest\n');
    await tailer.poll();
    expect(seen).toHaveLength(1);
    expect((seen[0]?.payload as { text: string }).text).toBe('half a line and the rest');
  });

  it('follows a rotation to the new inode', async () => {
    await writeFile(path, await readFile('fixtures/console-log/rotation-boundary.log', 'utf8'));
    const { tailer, seen } = tail();
    await tailer.start();
    expect(seen).toHaveLength(1);

    // Dota replaces the file rather than appending: old one moved aside, new one created.
    await rename(path, join(dir, 'console.log.1'));
    await writeFile(path, '[All Chat] AfterRotation: this line is in the second inode\n');
    await tailer.poll();

    expect(seen).toHaveLength(2);
    expect((seen[1]?.payload as { speaker: string }).speaker).toBe('AfterRotation');
    expect(tailer.stats().rotations).toBe(1);
    await tailer.stop();
  });

  it('recovers from a truncation instead of reading from the middle of a line', async () => {
    await writeFile(path, '[All Chat] A: one\n[All Chat] B: two\n[All Chat] C: three\n');
    const { tailer, seen } = tail();
    await tailer.start();
    expect(seen).toHaveLength(3);

    await writeFile(path, '[All Chat] D: after truncation\n');
    await tailer.poll();

    expect(seen).toHaveLength(4);
    expect((seen[3]?.payload as { text: string }).text).toBe('after truncation');
    expect(tailer.stats().truncations).toBe(1);
    await tailer.stop();
  });

  it('waits for a file that does not exist yet rather than failing', async () => {
    // Dota has not been launched with `-condebug`, or is mid-rotation. Neither is an error.
    const { tailer } = tail();
    await tailer.start();
    expect(tailer.health(0 as MonoMs).state).toBe('starting');
    expect(tailer.health(0 as MonoMs).reason).toContain('-condebug');
    await tailer.stop();
  });

  it('does not call a quiet log a dead one', async () => {
    // Unlike GSI there is no heartbeat here, so silence is weak evidence — and a supervisor
    // restarting a healthy tailer during every farming phase would be worse than useless.
    await writeFile(path, '[All Chat] A: one\n');
    const { tailer } = tail();
    await tailer.start();

    expect(tailer.health(60_000 as MonoMs).state).toBe('live');
    expect(tailer.health(400_000 as MonoMs).state).toBe('degraded');
    await tailer.stop();
  });

  it('numbers observations monotonically, so a gap is detectable downstream', async () => {
    await writeFile(path, '[All Chat] A: one\n[All Chat] B: two\n');
    const { tailer, seen } = tail();
    await tailer.start();
    await tailer.stop();

    expect(seen.map((o) => o.seq)).toEqual([0, 1]);
    expect(seen.map((o) => o.sourceId)).toEqual(['log-tail', 'log-tail']);
  });
});

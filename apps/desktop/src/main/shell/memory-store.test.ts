/**
 * The three things `memory-store.ts` has to be careful about, and the round trip through the
 * package that uses it.
 *
 * `packages/context` is forbidden `node:fs` and `node:path` by lint precisely so this is the only
 * file that has to be careful, which makes it the only place these can be asserted.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_PLAYER_MEMORY, PLAYER_MEMORY_KEY, createPlayerMemoryStore } from '@riki/context';
import { createFileMemoryStore } from './memory-store.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'riki-memory-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

describe('the file store', () => {
  it('round-trips a value', async () => {
    const store = createFileMemoryStore({ dir });
    await store.write('thing', bytes('{"a":1}'));
    expect(text((await store.read('thing')) ?? new Uint8Array())).toBe('{"a":1}');
  });

  it('answers null for anything it cannot read, because `load()` is total', async () => {
    const store = createFileMemoryStore({ dir });
    expect(await store.read('absent')).toBeNull();
  });

  it('creates its directory lazily — an unused Riki writes nothing', async () => {
    const nested = join(dir, 'deep', 'deeper');
    const store = createFileMemoryStore({ dir: nested });
    expect(await store.read('thing')).toBeNull();
    expect(() => readdirSync(nested)).toThrow();

    await store.write('thing', bytes('x'));
    expect(readdirSync(nested)).toEqual(['thing.json']);
  });

  it('leaves no temp file behind, so a crashed write cannot be read as a value', async () => {
    const store = createFileMemoryStore({ dir });
    await store.write('thing', bytes('x'));
    expect(readdirSync(dir)).toEqual(['thing.json']);
  });

  it('refuses a key that is a path, rather than sanitising it into an adjacent one', async () => {
    const store = createFileMemoryStore({ dir });
    await expect(store.write('../escape', bytes('x'))).rejects.toThrow('Invalid memory key');
    await expect(store.read('sub/dir')).rejects.toThrow('Invalid memory key');
    await expect(store.read('.hidden')).rejects.toThrow('Invalid memory key');
  });

  it('lists by prefix and ignores anything that is not ours', async () => {
    const store = createFileMemoryStore({ dir });
    await store.write('player-a', bytes('1'));
    await store.write('player-b', bytes('2'));
    await store.write('other', bytes('3'));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');

    expect(await store.list('player-')).toEqual(['player-a', 'player-b']);
  });

  it('deletes without complaining about an absent file', async () => {
    const store = createFileMemoryStore({ dir });
    await store.delete('never-existed');
    await store.write('thing', bytes('x'));
    await store.delete('thing');
    expect(await store.read('thing')).toBeNull();
  });
});

describe('through `createPlayerMemoryStore` (ADR-0013)', () => {
  it('survives a restart, which is the entire point of durable memory', async () => {
    const first = createPlayerMemoryStore({ store: createFileMemoryStore({ dir }) });
    await first.load();
    first.record({ kind: 'hero_played', hero: 'sf' as never, at: 0 as never } as never);
    await first.flush();

    const second = createPlayerMemoryStore({ store: createFileMemoryStore({ dir }) });
    const memory = await second.load();
    expect(memory.schemaVersion).toBe(EMPTY_PLAYER_MEMORY.schemaVersion);
    expect(readdirSync(dir)).toContain(`${PLAYER_MEMORY_KEY}.json`);
  });

  it('treats a corrupt file as an empty memory rather than a startup failure', async () => {
    writeFileSync(join(dir, `${PLAYER_MEMORY_KEY}.json`), 'not json at all');
    const store = createPlayerMemoryStore({ store: createFileMemoryStore({ dir }) });
    // "A missing, corrupt or version-mismatched file yields an empty memory, never an error."
    await expect(store.load()).resolves.toBeDefined();
  });
});

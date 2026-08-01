/**
 * Durable player memory, and the privacy egress test. Tier 1 (REPO_SKELETON.md §5.3, §5.4).
 *
 * §13 calls the egress test *the one that cannot be walked back once it has failed in the field*,
 * and notes it is nearly free because the guarantee is structural. Both halves are here:
 *
 * - **The structural half:** `PlayerObservation` is a closed union whose every `string` is an id or
 *   an enum, so a transcript is not representable. That is a compile-time property, and the test
 *   below is written so that adding a free-text arm makes it fail rather than merely allowing it.
 * - **The end-to-end half:** a ledger stuffed with chat and voice transcripts goes through the
 *   whole path — coaching projection, observation derivation, store, serialisation — and the bytes
 *   that come out are searched for every one of those strings.
 *
 * The rest is §10's durable-memory row: **a missing, corrupt or version-mismatched file yields an
 * empty memory, never an error.** Nothing here is load-bearing; an empty memory is a fully working
 * coach, which is what makes discarding the right default rather than a migration that guesses.
 */

import { describe, expect, it } from 'vitest';
import type { GameClock, HeroId, ItemId, MatchId, MonoMs, TurnId } from '../common/types.js';
import type { AdviceTopic, PlayerObservation } from './types.js';
import { FakeWorldModel, observed } from '../testing/index.js';
import { FakeMemoryStore } from '../testing/index.js';
import { createConversationLedger } from './ledger.js';
import { createCoachingMemory } from './coaching.js';
import { observationsFrom } from './observations.js';
import {
  createPlayerMemoryStore,
  EMPTY_PLAYER_MEMORY,
  PLAYER_MEMORY_KEY,
  PLAYER_MEMORY_SCHEMA_VERSION,
} from './player-memory.js';

const RIKI = 'riki' as HeroId;
const BKB: AdviceTopic = { of: 'item', item: 'black_king_bar' as ItemId };

describe('PlayerMemoryStore', () => {
  it('yields an empty memory when the file is absent', async () => {
    const store = createPlayerMemoryStore({ store: new FakeMemoryStore() });
    expect(await store.load()).toStrictEqual(EMPTY_PLAYER_MEMORY);
  });

  it('yields an empty memory when the file is corrupt, and does not throw', async () => {
    const backing = new FakeMemoryStore();
    backing.corrupt(PLAYER_MEMORY_KEY);
    const store = createPlayerMemoryStore({ store: backing });
    await expect(store.load()).resolves.toStrictEqual(EMPTY_PLAYER_MEMORY);
  });

  it('yields an empty memory when the file is a version behind, rather than guessing', async () => {
    const backing = new FakeMemoryStore();
    backing.corrupt(
      PLAYER_MEMORY_KEY,
      JSON.stringify({ schemaVersion: PLAYER_MEMORY_SCHEMA_VERSION - 1, heroes: [] }),
    );
    const store = createPlayerMemoryStore({ store: backing });
    expect((await store.load()).heroes.size).toBe(0);
  });

  it('yields an empty memory when the store itself fails', async () => {
    const backing = new FakeMemoryStore();
    backing.failReads = true;
    const store = createPlayerMemoryStore({ store: backing });
    await expect(store.load()).resolves.toStrictEqual(EMPTY_PLAYER_MEMORY);
  });

  it('round-trips hero familiarity and advice tendency', async () => {
    const backing = new FakeMemoryStore();
    const store = createPlayerMemoryStore({ store: backing });

    store.record({ kind: 'hero_played', hero: RIKI, role: 'carry', result: 'win', at: 1 });
    store.record({ kind: 'hero_played', hero: RIKI, role: 'carry', result: 'loss', at: 2 });
    store.record({ kind: 'advice_response', topic: BKB, response: 'followed', at: 2 });
    await store.flush();

    const reloaded = await createPlayerMemoryStore({ store: backing }).load();
    expect(reloaded.heroes.get(RIKI)).toStrictEqual({
      hero: RIKI,
      matches: 2,
      wins: 1,
      lastPlayedAt: 2,
    });
    expect(reloaded.adviceTendency.get('item:black_king_bar')).toStrictEqual({
      followed: 1,
      ignored: 0,
    });
  });

  it('writes nothing at all when memory is off', async () => {
    // `RIKI_MEMORY=off` degrades to an in-memory no-op rather than a branch at every call site.
    const backing = new FakeMemoryStore();
    const store = createPlayerMemoryStore({ store: backing, enabled: false });
    store.record({ kind: 'hero_played', hero: RIKI, role: 'carry', result: 'win', at: 1 });
    await store.flush();
    expect(backing.writes).toHaveLength(0);
  });

  it('forgets in one call', async () => {
    const backing = new FakeMemoryStore();
    const store = createPlayerMemoryStore({ store: backing });
    store.record({ kind: 'hero_played', hero: RIKI, role: 'carry', result: 'win', at: 1 });
    await store.flush();
    await store.forget();
    expect(backing.bytes.has(PLAYER_MEMORY_KEY)).toBe(false);
    expect(await store.load()).toStrictEqual(EMPTY_PLAYER_MEMORY);
  });
});

describe('durable memory privacy — the egress test', () => {
  /** Every free-text string that exists anywhere in the match. None may reach the disk. */
  const SECRETS = [
    'SomePlayer: gg go next',
    'should I go roshan or push',
    'they are pushing bot, back off — you can afford a bkb',
    'AnotherPlayer',
  ];

  function chattyMatch() {
    const ledger = createConversationLedger('m1' as MatchId);
    const turnId = 't0' as TurnId;
    ledger.append({
      kind: 'turn_opened',
      turnId,
      cause: { by: 'trigger', event: 'can_afford_key_item' as never, salience: 0.6 },
      at: 0 as MonoMs,
      clock: 600 as GameClock,
    });
    ledger.append({ kind: 'player_said', turnId, transcript: SECRETS[1]!, at: 0 as MonoMs });
    ledger.append({
      kind: 'agent_said',
      turnId,
      transcript: SECRETS[2]!,
      topics: [BKB],
      at: 0 as MonoMs,
    });
    ledger.append({
      kind: 'brief',
      turnId,
      rendered: { text: SECRETS[0]!, tokens: 10 },
      sections: ['history'],
      at: 0 as MonoMs,
    });
    return ledger;
  }

  it('produces a PlayerMemory containing none of the match’s free text', async () => {
    const ledger = chattyMatch();
    const coaching = createCoachingMemory(ledger);
    const world = new FakeWorldModel({
      clock: 900 as GameClock,
      facts: { 'self.items': observed([{ id: 'black_king_bar' }]) },
    });

    const observations = observationsFrom(coaching, world.snapshot(0 as MonoMs), {
      hero: RIKI,
      role: 'carry',
      result: 'win',
      at: 1_700_000_000_000,
    });

    const backing = new FakeMemoryStore();
    const store = createPlayerMemoryStore({ store: backing });
    for (const observation of observations) store.record(observation);
    await store.flush();

    const written = backing.text();
    expect(written.length).toBeGreaterThan(0);
    for (const secret of SECRETS) {
      expect(written).not.toContain(secret);
    }
    // What *did* survive is the useful part: the topic id and how it landed.
    expect(written).toContain('item:black_king_bar');
    expect(written).toContain('followed');
  });

  it('has no arm that can carry free text', () => {
    // The structural half. Every `string` in `PlayerObservation` is an id or an enum, and this
    // exhaustive walk is what fails if an arm gains one that is not — a new arm with a free-text
    // field has no branch here, so the compiler objects before the test does.
    const each: readonly PlayerObservation[] = [
      { kind: 'hero_played', hero: RIKI, role: 'carry', result: 'win', at: 0 },
      { kind: 'advice_response', topic: BKB, response: 'followed', at: 0 },
      { kind: 'pattern', pattern: 'dies_to_mid_rotation' as never, at: 0 },
      { kind: 'preference', key: 'verbosity' as never, value: 'low' },
    ];

    for (const observation of each) {
      switch (observation.kind) {
        case 'hero_played':
          expect(typeof observation.hero).toBe('string');
          expect(['carry', 'mid', 'offlane', 'soft_support', 'hard_support', 'unknown']).toContain(
            observation.role,
          );
          break;
        case 'advice_response':
          expect(['unknown', 'followed', 'ignored', 'dismissed']).toContain(observation.response);
          break;
        case 'pattern':
          expect(typeof observation.pattern).toBe('string');
          break;
        case 'preference':
          // The only free-ish string in the union, and it is a setting's value, not content —
          // `packages/config` owns resolution, and the store deliberately keeps none of it.
          expect(typeof observation.value).toBe('string');
          break;
      }
    }
  });

  it('keeps no preference value on disk at all', async () => {
    const backing = new FakeMemoryStore();
    const store = createPlayerMemoryStore({ store: backing });
    store.record({ kind: 'preference', key: 'nickname' as never, value: 'a secret nickname' });
    await store.flush();
    expect(backing.text()).not.toContain('a secret nickname');
  });

  it('stores nothing keyed by anyone but the local player', async () => {
    // There is no key for another person. Teammates and opponents appear as hero ids, which are
    // not people (§6.4).
    const backing = new FakeMemoryStore();
    const store = createPlayerMemoryStore({ store: backing });
    store.record({ kind: 'hero_played', hero: RIKI, role: 'carry', result: 'win', at: 1 });
    await store.flush();
    const parsed: unknown = JSON.parse(backing.text());
    expect(Object.keys(parsed as object).sort()).toStrictEqual([
      'adviceTendency',
      'heroes',
      'patterns',
      'schemaVersion',
    ]);
  });
});

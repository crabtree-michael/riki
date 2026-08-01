/**
 * Durable player memory — §6.4, ADR-0013. Across matches, on disk, and deliberately the most
 * constrained thing in this component.
 *
 * What it buys, and why it is worth a persistence surface at all: dota2 §2.4 already sources hero
 * comfort and match history from OpenDota, which is public and coarse. What Riki can know and
 * OpenDota cannot is **how this player responds to this coach** — that they act on ward advice and
 * ignore rune reminders. That is the difference between a coach and a stats site, and it is three
 * lines in the preamble.
 *
 * Four rules, all structural rather than remembered:
 *
 * - **No free text.** `PlayerObservation` is a closed union whose every `string` is an id or an
 *   enum, so chat lines, voice transcripts, player names and model output are *not representable*.
 *   That is stronger than not-written, and `player-memory.test.ts` asserts it by feeding a ledger
 *   full of chat through the whole path and searching the serialised bytes for it.
 * - **The local player only.** There is no key for anyone else. Teammates and opponents appear as
 *   hero ids, which are not people.
 * - **Version and discard.** A missing, corrupt or version-mismatched file yields an empty memory
 *   and a telemetry line, never an error. Nothing here is load-bearing — an empty memory is a fully
 *   working coach — which is exactly what makes discarding the right default rather than a
 *   best-effort migration that guesses.
 * - **No `fs`, no paths, no `process.env`.** `MemoryStore` is a four-method key/value port that the
 *   composition root implements against a directory `packages/config` resolved (§2.3's second lint
 *   rule). A convenient `await fs.writeFile` here would make the package untestable in a bare vitest
 *   process, put a path where config cannot see it, and give a privacy-relevant write no single
 *   audit point.
 */

import type { HeroId } from '../common/types.js';
import type { ContextTelemetry } from '../common/ports.js';
import type { PlayerMemoryStore } from './contracts.js';
import type { MemoryStore } from './ports.js';
import type {
  AdviceTendency,
  HeroFamiliarity,
  PatternCount,
  PatternId,
  PlayerMemory,
  PlayerObservation,
} from './types.js';
import { topicKey } from './coaching.js';

/** Bump on any change to the on-disk shape. A mismatch discards; it does not guess. */
export const PLAYER_MEMORY_SCHEMA_VERSION = 1;

/** One key, because there is one player. `MemoryStore` never learns a path. */
export const PLAYER_MEMORY_KEY = 'player-memory.json';

export const EMPTY_PLAYER_MEMORY: PlayerMemory = {
  schemaVersion: PLAYER_MEMORY_SCHEMA_VERSION,
  heroes: new Map(),
  adviceTendency: new Map(),
  patterns: [],
};

export interface PlayerMemoryStoreOptions {
  readonly store: MemoryStore;
  /**
   * `RIKI_MEMORY=off`, resolved by `packages/config` like every other setting.
   *
   * Disabled means an in-memory no-op rather than a branch at every call site: `record()` still
   * accepts, `flush()` still resolves, and nothing reaches the store. A call site that had to ask
   * "is memory on" before every write is a call site that will one day forget to.
   */
  readonly enabled?: boolean;
  readonly telemetry?: Pick<ContextTelemetry, 'noteTruncation'>;
}

/** The JSON shape. Maps are arrays on the wire; `PlayerMemory` is maps in memory. */
interface Persisted {
  readonly schemaVersion: number;
  readonly heroes: readonly HeroFamiliarity[];
  readonly adviceTendency: readonly (readonly [string, AdviceTendency])[];
  readonly patterns: readonly PatternCount[];
}

export function createPlayerMemoryStore(options: PlayerMemoryStoreOptions): PlayerMemoryStore {
  const enabled = options.enabled ?? true;
  const heroes = new Map<HeroId, HeroFamiliarity>();
  const tendency = new Map<string, AdviceTendency>();
  const patterns = new Map<PatternId, PatternCount>();
  let dirty = false;

  function current(): PlayerMemory {
    return {
      schemaVersion: PLAYER_MEMORY_SCHEMA_VERSION,
      heroes: new Map(heroes),
      adviceTendency: new Map(tendency),
      patterns: [...patterns.values()],
    };
  }

  function absorb(memory: PlayerMemory): void {
    heroes.clear();
    tendency.clear();
    patterns.clear();
    for (const [hero, familiarity] of memory.heroes) heroes.set(hero, familiarity);
    for (const [key, value] of memory.adviceTendency) tendency.set(key, value);
    for (const pattern of memory.patterns) patterns.set(pattern.pattern, pattern);
  }

  return {
    async load(): Promise<PlayerMemory> {
      if (!enabled) return EMPTY_PLAYER_MEMORY;

      // Total. Every failure below is the same failure — we do not have a usable memory — and the
      // response is the same: an empty one, a telemetry line, and a coach that works.
      const bytes = await options.store.read(PLAYER_MEMORY_KEY).catch(() => null);
      if (bytes === null) return EMPTY_PLAYER_MEMORY;

      const parsed = decode(bytes);
      if (parsed === null) {
        options.telemetry?.noteTruncation('player_memory', ['unreadable']);
        return EMPTY_PLAYER_MEMORY;
      }
      if (parsed.schemaVersion !== PLAYER_MEMORY_SCHEMA_VERSION) {
        options.telemetry?.noteTruncation('player_memory', ['schema_version']);
        return EMPTY_PLAYER_MEMORY;
      }

      const memory: PlayerMemory = {
        schemaVersion: parsed.schemaVersion,
        heroes: new Map(parsed.heroes.map((h) => [h.hero, h])),
        adviceTendency: new Map(parsed.adviceTendency),
        patterns: parsed.patterns,
      };
      absorb(memory);
      return memory;
    },

    /**
     * Folds one observation into the projection. Synchronous and cheap: the write is `flush()`.
     *
     * The switch is exhaustive over the closed union, which is the mechanism by which adding an arm
     * with a free-text field is a *compile* error here as well as a test failure in the egress test.
     */
    record(observation: PlayerObservation): void {
      dirty = true;
      switch (observation.kind) {
        case 'hero_played': {
          const previous = heroes.get(observation.hero);
          heroes.set(observation.hero, {
            hero: observation.hero,
            matches: (previous?.matches ?? 0) + 1,
            wins: (previous?.wins ?? 0) + (observation.result === 'win' ? 1 : 0),
            lastPlayedAt: observation.at,
          });
          return;
        }
        case 'advice_response': {
          // Keyed by topic identity, which is ids and enums — never by anything Riki said about it.
          const key = topicKey(observation.topic);
          const previous = tendency.get(key) ?? { followed: 0, ignored: 0 };
          tendency.set(key, {
            followed: previous.followed + (observation.response === 'followed' ? 1 : 0),
            ignored: previous.ignored + (observation.response === 'ignored' ? 1 : 0),
          });
          return;
        }
        case 'pattern': {
          const previous = patterns.get(observation.pattern);
          patterns.set(observation.pattern, {
            pattern: observation.pattern,
            count: (previous?.count ?? 0) + 1,
            lastAt: observation.at,
          });
          return;
        }
        case 'preference':
          // Preferences are settings and belong to `packages/config`, which owns resolution,
          // defaults and the privacy flags. Accepting the arm and storing nothing keeps the union
          // the single vocabulary while leaving one owner for a setting's value.
          return;
      }
    },

    /** Batched — at match end and on a slow timer, never per observation. */
    async flush(): Promise<void> {
      if (!enabled || !dirty) return;
      const memory = current();
      const persisted: Persisted = {
        schemaVersion: memory.schemaVersion,
        heroes: [...memory.heroes.values()],
        adviceTendency: [...memory.adviceTendency.entries()],
        patterns: memory.patterns,
      };
      await options.store.write(PLAYER_MEMORY_KEY, encode(persisted));
      dirty = false;
    },

    /** One settings button, one call, and the in-memory copy goes with the file. */
    async forget(): Promise<void> {
      absorb(EMPTY_PLAYER_MEMORY);
      dirty = false;
      if (enabled) await options.store.delete(PLAYER_MEMORY_KEY);
    },
  };
}

function encode(value: Persisted): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** `null` for anything that is not a well-formed `Persisted`. A guess would be worse than nothing. */
function decode(bytes: Uint8Array): Persisted | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<Persisted>;
    if (typeof candidate.schemaVersion !== 'number') return null;
    return {
      schemaVersion: candidate.schemaVersion,
      heroes: Array.isArray(candidate.heroes) ? candidate.heroes : [],
      adviceTendency: Array.isArray(candidate.adviceTendency) ? candidate.adviceTendency : [],
      patterns: Array.isArray(candidate.patterns) ? candidate.patterns : [],
    };
  } catch {
    return null;
  }
}

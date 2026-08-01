/**
 * The model itself.
 *
 * `dota2-state-capture-design.md` §4 gives this shape illustratively; what is fixed here is the
 * *discipline*, not the field list:
 *
 * 1. Every leaf is a `Fact<T>` — no bare values, so nothing can be read without its provenance.
 * 2. `undefined` means **never observed**, which is not the same as observed-to-be-absent. The
 *    snapshot renders those two differently, and a coach that confuses them is worse than silent.
 * 3. Nothing here is computed. Derived state lives in derived/, recomputed from this.
 *
 * The field list will grow during implementation; that is expected and is not a design change.
 * See docs/design/state-capture-architecture.md §3.5 and §11.1.
 *
 * ## Addressing
 *
 * Fusion, the delta computer and `WorldSnapshot.get()` all need to reach a leaf by name, so this
 * module also owns the `FieldPath` grammar and the only two functions that walk it:
 *
 * ```
 * meta.<key>        self.<key>        map.<key>
 * allies.<heroId>.<key>               enemies.<heroId>.<key>
 * enemies.<heroId>.itemsSeen.<itemId>
 * ```
 *
 * Keeping `readFact`/`writeFact` here rather than in the reducer is what stops a second, subtly
 * different notion of "where does `self.health` live" from growing inside fusion.
 */

import type { Fact } from './fact.js';
import { derivedFact } from './fact.js';
import type { RingHistory } from './history/ring.js';
import { createRingHistory } from './history/ring.js';
import type { WorldDelta } from './history/delta.js';
import type { GameClock, MonoMs, Seconds } from './time.js';

export type MatchId = string & { readonly __brand: 'MatchId' };
export type HeroId = string & { readonly __brand: 'HeroId' };
export type ItemId = string & { readonly __brand: 'ItemId' };
export type AbilityId = string & { readonly __brand: 'AbilityId' };
export type Team = 'radiant' | 'dire';

/** A dotted path into `WorldState`, e.g. `self.health` or `enemies.sf.position`. */
export type FieldPath = string & { readonly __brand: 'FieldPath' };

export type MatchPhase =
  'idle' | 'draft' | 'strategy' | 'hero_selection' | 'pre_game' | 'in_progress' | 'post_game';

/** Minimap coordinates, in Dota world units. §8.2 fairness: only ever what the minimap renders. */
export interface MapPosition {
  readonly x: number;
  readonly y: number;
}

export interface MatchMeta {
  readonly matchId: Fact<MatchId> | undefined;
  readonly phase: Fact<MatchPhase>;
  readonly clock: Fact<GameClock> | undefined;
  readonly paused: Fact<boolean>;
  readonly patch: Fact<string> | undefined;
  readonly team: Fact<Team> | undefined;
  /** Custom game / Turbo / Ability Draft: mode-specific advice is disabled rather than wrong. */
  readonly mode: Fact<string> | undefined;
  readonly lastUpdatedAt: MonoMs;
}

/** All GSI, all the time. CV never writes here — it feeds CvDriftMonitor instead (§5.6). */
export interface SelfState {
  readonly hero: Fact<HeroId> | undefined;
  readonly level: Fact<number> | undefined;
  /**
   * Total hero XP. Not in the architecture's illustrative list; added because `powerSpikeIn`
   * cannot answer "how long until level 12" from a level alone, and GSI's `hero.xp` gives it for
   * free.
   */
  readonly xp: Fact<number> | undefined;
  readonly alive: Fact<boolean> | undefined;
  readonly respawnIn: Fact<Seconds> | undefined;
  readonly health: Fact<{ current: number; max: number }> | undefined;
  readonly mana: Fact<{ current: number; max: number }> | undefined;
  readonly position: Fact<MapPosition> | undefined;
  readonly gold: Fact<{ reliable: number; unreliable: number }> | undefined;
  readonly netWorth: Fact<number> | undefined;
  readonly gpm: Fact<number> | undefined;
  readonly xpm: Fact<number> | undefined;
  readonly kda: Fact<{ kills: number; deaths: number; assists: number }> | undefined;
  readonly lastHits: Fact<number> | undefined;
  readonly denies: Fact<number> | undefined;
  readonly buyback: Fact<{ cost: number; cooldown: Seconds }> | undefined;
  /**
   * One fact for the whole loadout rather than an array of facts.
   *
   * The architecture wrote these as `readonly Fact<AbilityState>[]`. A single POST observes every
   * slot at one instant from one source, so per-slot provenance would be eight copies of the same
   * stamp — and an array of facts is not addressable by `FieldPath`, which would put both fields
   * outside precedence, ageing and delta computation. `Fact<readonly T[]>` is still "every leaf a
   * `Fact<T>`" (§3.5); it is the array that moved inside the envelope.
   */
  readonly abilities: Fact<readonly AbilityState[]> | undefined;
  readonly items: Fact<readonly ItemState[]> | undefined;
  readonly statuses: Fact<readonly StatusEffect[]> | undefined;
}

export interface AbilityState {
  readonly id: AbilityId;
  readonly level: number;
  readonly cooldown: Seconds;
  readonly castable: boolean;
  readonly isUltimate: boolean;
}

export interface ItemState {
  readonly id: ItemId;
  readonly slot: number;
  readonly location: 'inventory' | 'backpack' | 'stash' | 'neutral' | 'teleport';
  readonly charges: number | undefined;
  readonly cooldown: Seconds;
  readonly castable: boolean;
}

export type StatusEffect =
  | 'stunned'
  | 'silenced'
  | 'hexed'
  | 'disarmed'
  | 'muted'
  | 'break'
  | 'magicimmune'
  | 'smoked'
  | 'debuffed';

/** CV-derived and sparse. Almost everything is optional because almost everything is unseen. */
export interface AllyState {
  readonly hero: Fact<HeroId>;
  readonly level: Fact<number> | undefined;
  readonly alive: Fact<boolean> | undefined;
  readonly netWorth: Fact<number> | undefined;
  readonly position: Fact<MapPosition> | undefined;
  readonly lastSeenAt: Fact<MapPosition> | undefined;
}

export interface EnemyState {
  readonly hero: Fact<HeroId>;
  readonly level: Fact<number> | undefined;
  readonly alive: Fact<boolean> | undefined;
  readonly respawnIn: Fact<Seconds> | undefined;
  /** CV only, and expires. GSI cannot see it and §8.2 forbids inferring it any other way. */
  readonly position: Fact<MapPosition> | undefined;
  /** Scoreboard CV. Needed by `netWorthLead`, which answers null until all ten are known. */
  readonly netWorth: Fact<number> | undefined;
  /**
   * Keyed by item so a second sighting refreshes the first rather than appending a duplicate.
   * Each entry keeps its own confidence and age: seeing a Blink at 0.91 twenty seconds ago is a
   * different claim from seeing a BKB at 0.55 four minutes ago.
   */
  readonly itemsSeen: ReadonlyMap<ItemId, Fact<ItemId>>;
  /**
   * Survives the expiry of `position`. This is what lets the snapshot say `unseen >20s: ws, zeus`
   * instead of silently dropping two heroes — the distinction only exists if the structure has
   * somewhere to put it.
   *
   * Written by the same reducer step that writes `position` and given a far longer expiry, so
   * "where were they last" outlives "where are they" with nothing having to run on a timer.
   */
  readonly lastSeenAt: Fact<MapPosition> | undefined;
}

export interface MapState {
  readonly buildings: Fact<BuildingsState> | undefined;
  readonly daytime: Fact<boolean> | undefined;
  readonly roshanState: Fact<RoshanState> | undefined;
  /** One CV pass observes the whole visible ward set, so it is one fact, not one fact per ward. */
  readonly wardsSeen: Fact<readonly MapPosition[]> | undefined;
}

export type RoshanState = 'alive' | 'dead' | 'unknown';

export interface BuildingsState {
  readonly towers: Readonly<Record<string, number>>;
  readonly barracks: Readonly<Record<string, number>>;
  readonly ancient: Readonly<Record<Team, number>>;
}

export interface ChatLine {
  readonly text: string;
  readonly speaker: string | undefined;
  readonly channel: 'all' | 'team' | 'system';
  /** Always sensitive — these are other people's words (dota2 §7). */
  readonly privacy: 'sensitive';
}

export interface WorldState {
  readonly version: number;
  readonly meta: MatchMeta;
  readonly self: SelfState;
  readonly allies: ReadonlyMap<HeroId, AllyState>;
  readonly enemies: ReadonlyMap<HeroId, EnemyState>;
  readonly map: MapState;
  readonly chat: RingHistory<ChatLine>;
  readonly history: RingHistory<WorldDelta>;
}

// -----------------------------------------------------------------------------------------------
// Field paths
// -----------------------------------------------------------------------------------------------

export const META_KEYS = ['matchId', 'phase', 'clock', 'paused', 'patch', 'team', 'mode'] as const;

export const SELF_KEYS = [
  'hero',
  'level',
  'xp',
  'alive',
  'respawnIn',
  'health',
  'mana',
  'position',
  'gold',
  'netWorth',
  'gpm',
  'xpm',
  'kda',
  'lastHits',
  'denies',
  'buyback',
  'abilities',
  'items',
  'statuses',
] as const;

export const MAP_KEYS = ['buildings', 'daytime', 'roshanState', 'wardsSeen'] as const;

export const ALLY_KEYS = ['hero', 'level', 'alive', 'netWorth', 'position', 'lastSeenAt'] as const;

export const ENEMY_KEYS = [
  'hero',
  'level',
  'alive',
  'respawnIn',
  'position',
  'netWorth',
  'lastSeenAt',
] as const;

/** Builds a path from segments. The only place a `FieldPath` is constructed. */
export function fieldPath(...segments: readonly string[]): FieldPath {
  return segments.join('.') as FieldPath;
}

export function heroField(side: 'allies' | 'enemies', hero: HeroId, key: string): FieldPath {
  return fieldPath(side, hero, key);
}

export function itemSeenField(hero: HeroId, item: ItemId): FieldPath {
  return fieldPath('enemies', hero, 'itemsSeen', item);
}

/**
 * A parsed path, or `null` for anything that does not name a leaf this module declares.
 *
 * Rejecting unknown paths matters more than it looks: without it a typo in a reducer arm would
 * create a field that fusion writes, ageing never classifies and no renderer reads — a fact that
 * exists and is invisible, which is the hardest kind of missing advice to notice.
 */
export type ParsedPath =
  | { readonly root: 'meta' | 'self' | 'map'; readonly key: string }
  | { readonly root: 'allies' | 'enemies'; readonly hero: HeroId; readonly key: string }
  | { readonly root: 'itemsSeen'; readonly hero: HeroId; readonly item: ItemId };

const META_SET: ReadonlySet<string> = new Set(META_KEYS);
const SELF_SET: ReadonlySet<string> = new Set(SELF_KEYS);
const MAP_SET: ReadonlySet<string> = new Set(MAP_KEYS);
const ALLY_SET: ReadonlySet<string> = new Set(ALLY_KEYS);
const ENEMY_SET: ReadonlySet<string> = new Set(ENEMY_KEYS);

export function parsePath(path: FieldPath): ParsedPath | null {
  const parts = path.split('.');
  const root = parts[0];
  const second = parts[1];
  if (root === undefined || second === undefined) return null;

  if (root === 'meta') return META_SET.has(second) ? { root, key: second } : null;
  if (root === 'self') return SELF_SET.has(second) ? { root, key: second } : null;
  if (root === 'map') return MAP_SET.has(second) ? { root, key: second } : null;

  if (root === 'allies' || root === 'enemies') {
    const key = parts[2];
    if (key === undefined) return null;
    const hero = second as HeroId;
    if (root === 'enemies' && key === 'itemsSeen') {
      const item = parts[3];
      return item === undefined ? null : { root: 'itemsSeen', hero, item: item as ItemId };
    }
    const allowed = root === 'allies' ? ALLY_SET : ENEMY_SET;
    return allowed.has(key) ? { root, hero, key } : null;
  }

  return null;
}

// -----------------------------------------------------------------------------------------------
// Reading and writing leaves
// -----------------------------------------------------------------------------------------------

/**
 * The one place the model is indexed by string.
 *
 * The casts are confined to these functions deliberately: `parsePath` has already checked the key
 * against the declared key set, so the record view is sound for exactly the paths that reach here
 * and no caller has to reproduce that reasoning.
 */
type FactRecord = Record<string, Fact<unknown> | undefined>;

export function readFact(state: WorldState, path: FieldPath): Fact<unknown> | undefined {
  const parsed = parsePath(path);
  if (parsed === null) return undefined;

  switch (parsed.root) {
    case 'meta':
      return (state.meta as unknown as FactRecord)[parsed.key];
    case 'self':
      return (state.self as unknown as FactRecord)[parsed.key];
    case 'map':
      return (state.map as unknown as FactRecord)[parsed.key];
    case 'allies':
      return (state.allies.get(parsed.hero) as unknown as FactRecord | undefined)?.[parsed.key];
    case 'enemies':
      return (state.enemies.get(parsed.hero) as unknown as FactRecord | undefined)?.[parsed.key];
    case 'itemsSeen':
      return state.enemies.get(parsed.hero)?.itemsSeen.get(parsed.item);
  }
}

/**
 * A new state with one leaf replaced, sharing everything it did not touch.
 *
 * Writing a hero field for a hero with no entry creates the entry: observing where Shadow Fiend is
 * *is* observing that Shadow Fiend is in this game. The synthesised `hero` fact inherits the
 * incoming fact's provenance and timestamps, so a CV-created entry cannot be mistaken for a
 * draft-confirmed one further down.
 */
export function writeFact(state: WorldState, path: FieldPath, fact: Fact<unknown>): WorldState {
  const parsed = parsePath(path);
  if (parsed === null) return state;

  switch (parsed.root) {
    case 'meta':
      return { ...state, meta: { ...state.meta, [parsed.key]: fact } };
    case 'self':
      return { ...state, self: { ...state.self, [parsed.key]: fact } };
    case 'map':
      return { ...state, map: { ...state.map, [parsed.key]: fact } };
    case 'allies': {
      const allies = new Map(state.allies);
      allies.set(parsed.hero, { ...allyOrNew(state, parsed.hero, fact), [parsed.key]: fact });
      return { ...state, allies };
    }
    case 'enemies': {
      const enemies = new Map(state.enemies);
      enemies.set(parsed.hero, { ...enemyOrNew(state, parsed.hero, fact), [parsed.key]: fact });
      return { ...state, enemies };
    }
    case 'itemsSeen': {
      const enemies = new Map(state.enemies);
      const base = enemyOrNew(state, parsed.hero, fact);
      const itemsSeen = new Map(base.itemsSeen);
      itemsSeen.set(parsed.item, fact as Fact<ItemId>);
      enemies.set(parsed.hero, { ...base, itemsSeen });
      return { ...state, enemies };
    }
  }
}

function allyOrNew(state: WorldState, hero: HeroId, from: Fact<unknown>): AllyState {
  return (
    state.allies.get(hero) ?? {
      hero: { ...from, value: hero },
      level: undefined,
      alive: undefined,
      netWorth: undefined,
      position: undefined,
      lastSeenAt: undefined,
    }
  );
}

function enemyOrNew(state: WorldState, hero: HeroId, from: Fact<unknown>): EnemyState {
  return (
    state.enemies.get(hero) ?? {
      hero: { ...from, value: hero },
      level: undefined,
      alive: undefined,
      respawnIn: undefined,
      position: undefined,
      netWorth: undefined,
      itemsSeen: new Map(),
      lastSeenAt: undefined,
    }
  );
}

/**
 * Every leaf currently holding a fact, keyed by path.
 *
 * Drives `DeltaComputer` and `WorldSnapshot.get()`. Never-observed leaves are absent rather than
 * present-and-undefined, which is what lets a delta tell "appeared" from "unchanged".
 */
export function flattenFacts(state: WorldState): ReadonlyMap<FieldPath, Fact<unknown>> {
  const out = new Map<FieldPath, Fact<unknown>>();

  const collect = (prefix: readonly string[], keys: readonly string[], holder: unknown): void => {
    const record = holder as FactRecord;
    for (const key of keys) {
      const fact = record[key];
      if (fact !== undefined) out.set(fieldPath(...prefix, key), fact);
    }
  };

  collect(['meta'], META_KEYS, state.meta);
  collect(['self'], SELF_KEYS, state.self);
  collect(['map'], MAP_KEYS, state.map);

  for (const [hero, ally] of state.allies) collect(['allies', hero], ALLY_KEYS, ally);
  for (const [hero, enemy] of state.enemies) {
    collect(['enemies', hero], ENEMY_KEYS, enemy);
    for (const [item, fact] of enemy.itemsSeen) out.set(itemSeenField(hero, item), fact);
  }

  return out;
}

// -----------------------------------------------------------------------------------------------
// The empty state
// -----------------------------------------------------------------------------------------------

export interface EmptyStateOptions {
  /** dota2 §4 asks for ~5 minutes of delta history. */
  readonly historyWindowSeconds?: number;
  readonly historyMaxEntries?: number;
  readonly chatMaxEntries?: number;
}

export const DEFAULT_HISTORY_WINDOW_SECONDS = 300;
const DEFAULT_HISTORY_MAX_ENTRIES = 2000;
const DEFAULT_CHAT_MAX_ENTRIES = 200;

/**
 * The starting state for a new match.
 *
 * `phase` and `paused` are not optional in `MatchMeta`, so they need a value before anything has
 * been observed. They are stamped `derived`, and saying so is the point: nothing observed them,
 * and the precedence matrix gives `derived` no rank in the `meta` class, so the first GSI POST
 * replaces both without a shadow-window argument.
 */
export function emptyState(now: MonoMs, opts: EmptyStateOptions = {}): WorldState {
  const at = { observedAt: now, atGameClock: null };
  const windowSeconds = opts.historyWindowSeconds ?? DEFAULT_HISTORY_WINDOW_SECONDS;

  return {
    version: 0,
    meta: {
      matchId: undefined,
      phase: derivedFact<MatchPhase>('idle', at, []),
      clock: undefined,
      paused: derivedFact(false, at, []),
      patch: undefined,
      team: undefined,
      mode: undefined,
      lastUpdatedAt: now,
    },
    self: {
      hero: undefined,
      level: undefined,
      xp: undefined,
      alive: undefined,
      respawnIn: undefined,
      health: undefined,
      mana: undefined,
      position: undefined,
      gold: undefined,
      netWorth: undefined,
      gpm: undefined,
      xpm: undefined,
      kda: undefined,
      lastHits: undefined,
      denies: undefined,
      buyback: undefined,
      abilities: undefined,
      items: undefined,
      statuses: undefined,
    },
    allies: new Map(),
    enemies: new Map(),
    map: {
      buildings: undefined,
      daytime: undefined,
      roshanState: undefined,
      wardsSeen: undefined,
    },
    chat: createRingHistory<ChatLine>({
      windowSeconds,
      maxEntries: opts.chatMaxEntries ?? DEFAULT_CHAT_MAX_ENTRIES,
    }),
    history: createRingHistory<WorldDelta>({
      windowSeconds,
      maxEntries: opts.historyMaxEntries ?? DEFAULT_HISTORY_MAX_ENTRIES,
    }),
  };
}

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
 */

import type { Fact } from './fact.js';
import type { RingHistory } from './history/ring.js';
import type { WorldDelta } from './history/delta.js';
import type { GameClock, MonoMs, Seconds } from './time.js';

export type MatchId = string & { readonly __brand: 'MatchId' };
export type HeroId = string & { readonly __brand: 'HeroId' };
export type ItemId = string & { readonly __brand: 'ItemId' };
export type AbilityId = string & { readonly __brand: 'AbilityId' };
export type Team = 'radiant' | 'dire';

/** A dotted path into `WorldState`, e.g. `self.hp` or `enemies.sf.position`. */
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
  readonly abilities: readonly Fact<AbilityState>[];
  readonly items: readonly Fact<ItemState>[];
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
  readonly itemsSeen: readonly Fact<ItemId>[];
  /**
   * Survives the expiry of `position`. This is what lets the snapshot say `unseen >20s: ws, zeus`
   * instead of silently dropping two heroes — the distinction only exists if the structure has
   * somewhere to put it.
   */
  readonly lastSeenAt: Fact<MapPosition> | undefined;
}

export interface MapState {
  readonly buildings: Fact<BuildingsState> | undefined;
  readonly daytime: Fact<boolean> | undefined;
  readonly roshanState: Fact<'alive' | 'dead' | 'unknown'> | undefined;
  readonly wardsSeen: readonly Fact<MapPosition>[];
}

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

/** The starting state for a new match. Not exported as a value until fusion lands. */
export declare function emptyState(now: MonoMs): WorldState;

/**
 * A GSI POST, read into candidate facts.
 *
 * This module knows how Valve spells things and nothing else. Four parsing rules from §4.1 hold
 * here as well as in `packages/gsi`, and this is the layer where getting them wrong turns into
 * wrong advice rather than a parse error:
 *
 * - **A POST is a partial state.** Only enabled components appear and any of them may be missing
 *   from a given POST. Absent means *unchanged*, never *cleared* — so an absent component yields
 *   no candidates rather than candidates carrying `undefined`.
 * - **Unknown fields pass through.** Nothing here fails on a component it does not recognise;
 *   Valve adds them between patches and a strict reader turns a patch day into an outage.
 * - **`previously` and `added` are ignored** by construction: only the component keys below are
 *   read, so Valve's delta blocks are never even looked at.
 * - **`clock_time` is negative before the horn** and frozen while `map.paused`. It is read as-is;
 *   nothing here treats a negative clock as missing.
 *
 * ⚠ The payload is typed `unknown` at the seam (§3.3): `packages/gsi` owns the parsed shape and
 * the world model may not import it. So this reads structurally. When `@riki/protocol` lands the
 * structural readers below become a schema and this file loses its casts.
 */

import type { Timestamps } from '../fact.js';
import { gsiFact } from '../fact.js';
import type {
  AbilityId,
  AbilityState,
  BuildingsState,
  HeroId,
  ItemId,
  ItemState,
  MatchId,
  MatchPhase,
  StatusEffect,
  Team,
} from '../state.js';
import { fieldPath } from '../state.js';
import type { GameClock } from '../time.js';
import { asGameClock, asSeconds } from '../time.js';
import type { Candidate } from './candidate.js';
import { asRecord, readBoolean, readNumber, readRecord, readString } from './candidate.js';

/** Valve's `map.game_state` strings, mapped to the phase vocabulary the rest of Riki speaks. */
const PHASES: Readonly<Record<string, MatchPhase>> = {
  DOTA_GAMERULES_STATE_INIT: 'idle',
  DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD: 'idle',
  DOTA_GAMERULES_STATE_HERO_SELECTION: 'hero_selection',
  DOTA_GAMERULES_STATE_STRATEGY_TIME: 'strategy',
  DOTA_GAMERULES_STATE_TEAM_SHOWCASE: 'pre_game',
  DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD: 'pre_game',
  DOTA_GAMERULES_STATE_PRE_GAME: 'pre_game',
  DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 'in_progress',
  DOTA_GAMERULES_STATE_POST_GAME: 'post_game',
  DOTA_GAMERULES_STATE_DISCONNECT: 'post_game',
};

/** `hero.<flag>` → the status the model records. `has_debuff` is Valve's catch-all. */
const STATUS_FLAGS: readonly (readonly [string, StatusEffect])[] = [
  ['stunned', 'stunned'],
  ['silenced', 'silenced'],
  ['hexed', 'hexed'],
  ['disarmed', 'disarmed'],
  ['muted', 'muted'],
  ['break', 'break'],
  ['magicimmune', 'magicimmune'],
  ['smoked', 'smoked'],
  ['has_debuff', 'debuffed'],
];

/** Slots Valve exposes on the `items` component, in the order a player thinks about them. */
const ITEM_SLOTS: readonly (readonly [
  prefix: string,
  location: ItemState['location'],
  count: number,
])[] = [
  ['slot', 'inventory', 6],
  ['slot', 'backpack', 9],
  ['stash', 'stash', 6],
  ['teleport', 'teleport', 1],
  ['neutral', 'neutral', 1],
];

export function phaseOf(gameState: string | undefined): MatchPhase | undefined {
  return gameState === undefined ? undefined : PHASES[gameState];
}

/** `map.clock_time`, or null when the match has no clock yet. Negative pre-horn is a real value. */
export function clockOf(payload: unknown): GameClock | null {
  const clock = readNumber(readRecord(asRecord(payload), 'map'), 'clock_time');
  return clock === undefined ? null : asGameClock(clock);
}

/**
 * Every candidate a POST implies.
 *
 * Nothing here consults the current state: a candidate is what the payload *says*, and whether it
 * changes anything is the reducer's decision. That split is what makes the reducer's precedence
 * tests independent of Valve's field names.
 */
export function readGsiPayload(payload: unknown, at: Timestamps): readonly Candidate[] {
  const root = asRecord(payload);
  if (root === undefined) return [];

  const out: Candidate[] = [];
  const add = (path: string, value: unknown, origin: string): void => {
    if (value === undefined) return;
    out.push({ path: fieldPath(path), fact: gsiFact(value, at, origin) });
  };

  // --- map -------------------------------------------------------------------------------------
  const map = readRecord(root, 'map');
  if (map !== undefined) {
    // Branded through a typed local rather than at the call site: `add` takes `unknown`, so a
    // cast in the argument list would be erased and the lint would be right to call it useless.
    const matchId = readString(map, 'matchid') as MatchId | undefined;
    add('meta.matchId', matchId, 'map');
    add('meta.phase', phaseOf(readString(map, 'game_state')), 'map');
    const clock = readNumber(map, 'clock_time');
    add('meta.clock', clock === undefined ? undefined : asGameClock(clock), 'map');
    add('meta.paused', readBoolean(map, 'paused'), 'map');
    // A custom game name is only present for Turbo, Ability Draft and custom modes, which is
    // exactly the signal dota2 §9 wants: mode-specific advice is disabled, never guessed.
    add('meta.mode', readString(map, 'customgamename'), 'map');
    add('map.daytime', readBoolean(map, 'daytime'), 'map');
  }

  // --- player ----------------------------------------------------------------------------------
  const player = readRecord(root, 'player');
  if (player !== undefined) {
    const team = readString(player, 'team_name');
    if (team === 'radiant' || team === 'dire') add('meta.team', team, 'player');

    add('self.gpm', readNumber(player, 'gpm'), 'player');
    add('self.xpm', readNumber(player, 'xpm'), 'player');
    add('self.netWorth', readNumber(player, 'net_worth'), 'player');
    add('self.lastHits', readNumber(player, 'last_hits'), 'player');
    add('self.denies', readNumber(player, 'denies'), 'player');

    const reliable = readNumber(player, 'gold_reliable');
    const unreliable = readNumber(player, 'gold_unreliable');
    if (reliable !== undefined && unreliable !== undefined) {
      add('self.gold', { reliable, unreliable }, 'player');
    }

    const kills = readNumber(player, 'kills');
    const deaths = readNumber(player, 'deaths');
    const assists = readNumber(player, 'assists');
    if (kills !== undefined && deaths !== undefined && assists !== undefined) {
      add('self.kda', { kills, deaths, assists }, 'player');
    }
  }

  // --- hero ------------------------------------------------------------------------------------
  const hero = readRecord(root, 'hero');
  if (hero !== undefined) {
    const heroId = readString(hero, 'name') as HeroId | undefined;
    add('self.hero', heroId, 'hero');
    add('self.level', readNumber(hero, 'level'), 'hero');
    add('self.xp', readNumber(hero, 'xp'), 'hero');
    add('self.alive', readBoolean(hero, 'alive'), 'hero');

    const respawn = readNumber(hero, 'respawn_seconds');
    add('self.respawnIn', respawn === undefined ? undefined : asSeconds(respawn), 'hero');

    const health = readNumber(hero, 'health');
    const maxHealth = readNumber(hero, 'max_health');
    if (health !== undefined && maxHealth !== undefined) {
      add('self.health', { current: health, max: maxHealth }, 'hero');
    }

    const mana = readNumber(hero, 'mana');
    const maxMana = readNumber(hero, 'max_mana');
    if (mana !== undefined && maxMana !== undefined) {
      add('self.mana', { current: mana, max: maxMana }, 'hero');
    }

    // §8.2: the player can see their own hero, so their own coordinates break no fairness rule.
    // Enemy coordinates would, which is why GSI does not carry them and CV is the only path.
    const x = readNumber(hero, 'xpos');
    const y = readNumber(hero, 'ypos');
    if (x !== undefined && y !== undefined) add('self.position', { x, y }, 'hero');

    const buybackCost = readNumber(hero, 'buyback_cost');
    const buybackCooldown = readNumber(hero, 'buyback_cooldown');
    if (buybackCost !== undefined && buybackCooldown !== undefined) {
      add('self.buyback', { cost: buybackCost, cooldown: asSeconds(buybackCooldown) }, 'hero');
    }

    const statuses = STATUS_FLAGS.filter(([key]) => readBoolean(hero, key) === true).map(
      ([, status]) => status,
    );
    // Always emitted when the component is present, including empty: "no statuses" is an
    // observation, and omitting it would leave a stun from thirty seconds ago standing.
    add('self.statuses', statuses, 'hero');
  }

  const abilities = readAbilities(root.abilities);
  if (abilities !== undefined) {
    add('self.abilities', abilities, 'abilities');
  }

  const items = readItems(readRecord(root, 'items'));
  if (items !== undefined) add('self.items', items, 'items');

  const buildings = readBuildings(readRecord(root, 'buildings'));
  if (buildings !== undefined) add('map.buildings', buildings, 'buildings');

  return out;
}

/**
 * `abilities` arrives as `{ ability0: {...}, ability1: {...} }` on some builds and as a bare array
 * on others. Both are accepted: which one a given client sends is not ours to control, and
 * handling both costs four lines.
 */
function readAbilities(raw: unknown): readonly AbilityState[] | undefined {
  const source = Array.isArray(raw)
    ? raw.map(asRecord).filter((e): e is Readonly<Record<string, unknown>> => e !== undefined)
    : abilityEntries(asRecord(raw));
  if (source === undefined) return undefined;

  return source.flatMap((ability): AbilityState[] => {
    const id = readString(ability, 'name');
    if (id === undefined) return [];
    return [
      {
        id: id as AbilityId,
        level: readNumber(ability, 'level') ?? 0,
        cooldown: asSeconds(readNumber(ability, 'cooldown') ?? 0),
        castable: readBoolean(ability, 'can_cast') ?? false,
        isUltimate: readBoolean(ability, 'ultimate') ?? false,
      },
    ];
  });
}

/** `name: "empty"` is Valve's empty slot, and it is a slot with nothing in it, not a missing slot. */
function readItems(
  component: Readonly<Record<string, unknown>> | undefined,
): readonly ItemState[] | undefined {
  if (component === undefined) return undefined;

  const out: ItemState[] = [];
  for (const [prefix, location, count] of ITEM_SLOTS) {
    // The inventory and the backpack share the `slot` prefix: 0–5 are carried, 6–8 are backpack.
    const from = location === 'backpack' ? 6 : 0;
    for (let slot = from; slot < count; slot += 1) {
      const item = asRecord(component[`${prefix}${String(slot)}`]);
      const id = readString(item, 'name');
      if (id === undefined || id === 'empty') continue;
      out.push({
        id: id as ItemId,
        slot,
        location,
        charges: readNumber(item, 'charges'),
        cooldown: asSeconds(readNumber(item, 'cooldown') ?? 0),
        castable: readBoolean(item, 'can_cast') ?? false,
      });
    }
  }
  return out;
}

/**
 * `buildings` nests as `{ radiant: { dota_goodguys_tower1_top: { health, max_health } }, ... }`.
 * Flattened to `team:name → health`, because every consumer wants "is that tower down" and none of
 * them wants to walk two levels of Valve's naming to find out.
 */
function readBuildings(
  component: Readonly<Record<string, unknown>> | undefined,
): BuildingsState | undefined {
  if (component === undefined) return undefined;

  const towers: Record<string, number> = {};
  const barracks: Record<string, number> = {};
  const ancient: Record<Team, number> = { radiant: 0, dire: 0 };
  let sawAny = false;

  for (const team of ['radiant', 'dire'] as const) {
    const side = readRecord(component, team);
    if (side === undefined) continue;
    for (const [name, raw] of Object.entries(side)) {
      const health = readNumber(asRecord(raw), 'health');
      if (health === undefined) continue;
      sawAny = true;
      const key = `${team}:${name}`;
      if (name.includes('tower')) towers[key] = health;
      else if (name.includes('rax') || name.includes('barracks')) barracks[key] = health;
      else if (name.includes('fort') || name.includes('ancient')) ancient[team] = health;
    }
  }

  return sawAny ? { towers, barracks, ancient } : undefined;
}

function abilityEntries(
  component: Readonly<Record<string, unknown>> | undefined,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (component === undefined) return undefined;
  return Object.keys(component)
    .filter((key) => key.startsWith('ability'))
    .sort()
    .map((key) => asRecord(component[key]))
    .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== undefined);
}

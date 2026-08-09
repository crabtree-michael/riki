/**
 * Towers and barracks: how many are standing on each side, and which ones fell recently.
 *
 * Split out of `objectives.ts` because two of the three things here are fiddly for reasons that
 * have nothing to do with objectives — Valve's building names, and the fact that "recently lost"
 * has to be recovered from the delta ring rather than read from a field.
 */

import type { BuildingsReport } from '@riki/protocol';
import type { Fact } from '../fact.js';
import { derivedFact } from '../fact.js';
import type { BuildingsState, Team, WorldState } from '../state.js';
import { DEFAULT_HISTORY_WINDOW_SECONDS, fieldPath } from '../state.js';
import type { GameClock, MonoMs } from '../time.js';
import { asGameClock } from '../time.js';

const BUILDINGS_PATH = fieldPath('map', 'buildings');

/**
 * How far back `recently_lost` looks.
 *
 * Tied to the delta ring's own window rather than chosen independently, because it *is* that
 * window: history is where the losses are recovered from, so a longer number here would be a
 * promise the ring cannot keep. This is what gives the empty array a meaning — "nothing fell in the
 * last five minutes" — instead of leaving it as an unfalsifiable default.
 */
export const RECENTLY_LOST_WINDOW_SECONDS = DEFAULT_HISTORY_WINDOW_SECONDS;

/**
 * The buildings fact, or the reason there is not one.
 *
 * Two inputs, and both are required: the building healths, and *which side the player is on*.
 * Without `meta.team` this answers nothing rather than guessing which half of the map is theirs —
 * "you're up four towers", rendered the wrong way round, is a complete and confident sentence, and
 * the player has no way to tell. `apps/desktop/src/main/agent/world-view.ts` refuses on the same
 * grounds for the same projection; this is the second place that reasoning is load-bearing.
 *
 * The result is stamped `derived`, which through `derivedFact` gives it the minimum confidence and
 * the oldest `observedAt` of the two — so a fresh building read against a stale team assignment
 * reports as old as the team assignment.
 */
export function buildingsFact(
  state: WorldState,
  now: MonoMs,
  clock: GameClock | null,
): Fact<BuildingsReport> | null {
  const buildings = state.map.buildings;
  const team = state.meta.team;
  if (buildings === undefined || team === undefined) return null;

  return derivedFact<BuildingsReport>(
    {
      towers: countStanding(buildings.value.towers, team.value),
      barracks: countStanding(buildings.value.barracks, team.value),
      recently_lost: recentlyLost(state, team.value, clock),
    },
    { observedAt: now, atGameClock: clock },
    [buildings, team],
  );
}

/**
 * Standing is `health > 0`.
 *
 * Keys arrive from `read-gsi.ts` flattened to `team:name` — `radiant:dota_goodguys_tower1_top` — so
 * the side is the prefix and needs no knowledge of which of Valve's two nicknames means which team.
 */
function countStanding(
  healths: Readonly<Record<string, number>>,
  mine: Team,
): { readonly mine: number; readonly theirs: number } {
  let ours = 0;
  let theirs = 0;
  for (const [key, health] of Object.entries(healths)) {
    if (health <= 0) continue;
    if (sideOf(key) === mine) ours += 1;
    else theirs += 1;
  }
  return { mine: ours, theirs };
}

function sideOf(key: string): string {
  return key.slice(0, key.indexOf(':'));
}

/**
 * Buildings that went from standing to down inside the history window, newest first.
 *
 * T2 declared this field expecting it to be permanently unknown — "needs history nothing keeps".
 * That turns out to be wrong in a useful way: `WorldState.history` is a ring of `WorldDelta`, every
 * delta carries the `before` and `after` *facts* for each changed path, and `map.buildings` is one
 * of those paths. So a loss is exactly a health that was positive in `before` and is not in
 * `after`, and five minutes of them are sitting in the ring already.
 *
 * That matters more than a nice-to-have field, because `recently_lost` is a bare array inside
 * `BuildingsReport` rather than a fact of its own: there is no `unknown` branch to retreat to, so
 * whatever this returns is a claim. A hardcoded `[]` would be the claim "nothing has fallen", made
 * every time, in a voice product. The window above is what makes the real `[]` true instead.
 */
function recentlyLost(
  state: WorldState,
  mine: Team,
  clock: GameClock | null,
): BuildingsReport['recently_lost'] {
  // `since` skips entries with no match clock — they were recorded before the horn, when nothing
  // can have been destroyed. With no clock at all there is no window to ask about.
  const deltas =
    clock === null
      ? state.history.last(state.history.size)
      : state.history.since(asGameClock(clock - RECENTLY_LOST_WINDOW_SECONDS));

  const lost: { side: 'mine' | 'theirs'; name: string }[] = [];

  for (const delta of deltas) {
    for (const change of delta.changes) {
      if (change.path !== BUILDINGS_PATH) continue;
      const before = (change.before as Fact<BuildingsState> | undefined)?.value;
      const after = (change.after as Fact<BuildingsState> | undefined)?.value;
      if (before === undefined || after === undefined) continue;

      for (const group of ['towers', 'barracks'] as const) {
        for (const [key, health] of Object.entries(after[group])) {
          const was = before[group][key];
          if (was === undefined || was <= 0 || health > 0) continue;
          lost.push({ side: sideOf(key) === mine ? 'mine' : 'theirs', name: buildingName(key) });
        }
      }
    }
  }

  // The ring is oldest first and the schema asks for newest first, which is also the order anyone
  // says them in: "we just lost mid tier two, and top tier one before that".
  return lost.reverse();
}

const TOWER = /tower(\d)(?:_(top|mid|bot))?/;
const RAX = /(melee|range)_rax_(top|mid|bot)/;
const LANES: Readonly<Record<string, string>> = { top: 'top', mid: 'mid', bot: 'bottom' };

/**
 * `radiant:dota_goodguys_tower1_top` → `top tier 1`. Named for saying out loud, per the schema.
 *
 * Tier 4s get no lane even though Valve gives them one: both stand at the ancient, and "top tier 4"
 * describes a place on the map that does not mean what it says.
 */
export function buildingName(key: string): string {
  const raw = key.slice(key.indexOf(':') + 1);

  const tower = TOWER.exec(raw);
  if (tower !== null) {
    const [, tier, lane] = tower;
    const named = lane === undefined ? undefined : LANES[lane];
    return named === undefined || tier === '4'
      ? `tier ${String(tier)}`
      : `${named} tier ${String(tier)}`;
  }

  const rax = RAX.exec(raw);
  if (rax !== null) {
    const [, kind, lane] = rax;
    return `${LANES[lane ?? ''] ?? String(lane)} ${kind === 'melee' ? 'melee' : 'ranged'} barracks`;
  }

  // Anything Valve renames, or a building class this does not know about. The raw name read aloud
  // is poor, but it is not wrong, and silently dropping the entry would be.
  return raw.replace(/^dota_(goodguys|badguys)_/, '').replace(/_/g, ' ');
}

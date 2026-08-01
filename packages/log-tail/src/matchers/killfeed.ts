/**
 * Kills.
 *
 * > ⚠ **Unverified, for the same reason as `chat.ts`** — and rather more so. Chat definitely
 * > reaches `console.log`; whether kills do, and in what form, is exactly what
 * > `dota2-state-capture-design.md` §2.3 says needs checking against a current build. If it turns
 * > out they do not, this matcher is deleted and `enemies.*.alive` falls to the top-bar CV that
 * > the `enemy_liveness` precedence class already admits as a gap-filler.
 *
 * What is *not* a guess is the shape of the output: a kill yields the victim's death and nothing
 * else. The respawn timer is a function of level, which no log line carries, so inventing one
 * here would be the model's first fabricated number.
 */

import type { KillFeedEntry, LineMatcher, LogEvent } from '../contracts.js';
import { stripLogPrefix } from './chat.js';

/** `npc_dota_hero_pudge killed npc_dota_hero_lina` and the passive-voice variant. */
const KILLED = /^(npc_dota_hero_[a-z_0-9]+)\s+killed\s+(npc_dota_hero_[a-z_0-9]+)/i;
const KILLED_BY =
  /^(npc_dota_hero_[a-z_0-9]+)\s+(?:was\s+)?killed\s+by\s+(npc_dota_hero_[a-z_0-9]+)/i;
/** Deaths with no killer: denies to a tower, or a suicide. The victim is what matters. */
const DIED = /^(npc_dota_hero_[a-z_0-9]+)\s+(?:died|has\s+died)\b/i;

export function createKillFeedMatcher(): LineMatcher {
  return {
    id: 'killfeed',
    // The timestamps parameter is declared by `LineMatcher` and deliberately not taken: a
    // matcher is a pure function of the line, and reading a clock here would be the first
    // step towards one that decides what a line *means*, which is fusion's job.
    match(line: string): LogEvent | null {
      const body = stripLogPrefix(line);

      // `killed by` is checked first: it also matches `KILLED`, with the roles reversed, and
      // getting a kill backwards would put the wrong hero on a respawn timer.
      const passive = KILLED_BY.exec(body);
      if (passive !== null) return kill(passive[2], passive[1]);

      const active = KILLED.exec(body);
      if (active !== null) return kill(active[1], active[2]);

      const died = DIED.exec(body);
      if (died !== null) return kill(undefined, died[1]);

      return null;
    },
  };
}

function kill(killer: string | undefined, victim: string | undefined): KillFeedEntry | null {
  if (victim === undefined) return null;
  return { kind: 'kill', killer, victim, privacy: 'public' };
}

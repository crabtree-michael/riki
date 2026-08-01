/**
 * Match lifecycle, as edges rather than as state.
 *
 * The caller reacts to transitions — `match_started` triggers Tier 1 preamble assembly and
 * external API enrichment, `clock_discontinuity` triggers a resync — and a tracker that returned
 * "the current phase" would put the edge detection at every call site instead of here, where it
 * happens once and can be tested without any of them.
 *
 * See docs/design/state-capture-architecture.md §4.1 and §6.4.
 */

import { DISCONTINUITY_THRESHOLD_SECONDS } from './clock.js';
import type {
  MatchLifecycleEvent,
  MatchPhase,
  MatchSessionTracker,
  MonoMs,
  Seconds,
} from './contracts.js';
import type { GsiPayload } from './payload.js';

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

interface Session {
  matchId: string | undefined;
  phase: MatchPhase;
  paused: boolean;
  clock: number | undefined;
  clockAt: MonoMs | undefined;
}

export function createMatchSessionTracker(): MatchSessionTracker {
  const session: Session = {
    matchId: undefined,
    phase: 'idle',
    paused: false,
    clock: undefined,
    clockAt: undefined,
  };

  return {
    observe(payload: GsiPayload, at: { observedAt: MonoMs }): readonly MatchLifecycleEvent[] {
      const map = payload.map;
      if (map === undefined) return [];

      const events: MatchLifecycleEvent[] = [];
      const matchId = map.matchid;
      const phase = map.game_state === undefined ? undefined : PHASES[map.game_state];
      const paused = map.paused ?? session.paused;
      const clock = map.clock_time;

      // --- match identity ------------------------------------------------------------------
      if (matchId !== undefined && matchId !== session.matchId) {
        if (session.matchId !== undefined) {
          // A new id without an intervening post-game means the previous match never ended as far
          // as we saw. Reporting the end anyway is what keeps the composition root's state
          // machine from needing to handle "started twice".
          events.push({ type: 'match_ended', matchId: session.matchId, winner: null });
        }
        session.matchId = matchId;
        events.push({ type: 'match_started', matchId, heroes: draftHeroes(payload) });
      }

      // --- phase ---------------------------------------------------------------------------
      if (phase !== undefined && phase !== session.phase) {
        events.push({ type: 'phase_changed', from: session.phase, to: phase });
        if (phase === 'post_game' && session.matchId !== undefined) {
          events.push({ type: 'match_ended', matchId: session.matchId, winner: null });
        }
        session.phase = phase;
      }

      // --- pause ---------------------------------------------------------------------------
      if (paused !== session.paused) {
        events.push(paused ? { type: 'paused' } : { type: 'resumed' });
        session.paused = paused;
      }

      // --- clock ---------------------------------------------------------------------------
      if (clock !== undefined) {
        const previous = session.clock;
        const previousAt = session.clockAt;
        if (previous !== undefined && previousAt !== undefined && !session.paused) {
          const expected = previous + Math.max(0, at.observedAt - previousAt) / 1000;
          const delta = clock - expected;
          // Backwards at all, or forwards by more than the threshold: a reconnect, or a new match
          // reusing the id. Either way a slow drift into wrongness is the thing to avoid, so the
          // caller resyncs rather than letting the model catch up on its own.
          if (delta < -DISCONTINUITY_THRESHOLD_SECONDS || delta > DISCONTINUITY_THRESHOLD_SECONDS) {
            events.push({ type: 'clock_discontinuity', delta: delta as Seconds });
          }
        }
        session.clock = clock;
        session.clockAt = at.observedAt;
      }

      return events;
    },
  };
}

/**
 * The ten heroes, if the draft component is populated.
 *
 * It only is during the draft phase, so `match_started` seen mid-match carries an empty roster —
 * which is exactly the case the `roster` precedence class exists for, since CV's top bar then
 * has to be able to name a hero GSI never did.
 */
function draftHeroes(payload: GsiPayload): readonly string[] {
  const draft = payload.draft;
  if (draft === undefined) return [];

  const heroes: string[] = [];
  for (const team of Object.values(draft)) {
    if (typeof team !== 'object' || team === null) continue;
    for (const [key, pick] of Object.entries(team as Record<string, unknown>)) {
      if (!key.startsWith('pick')) continue;
      if (typeof pick === 'object' && pick !== null) {
        const hero = (pick as Record<string, unknown>).hero;
        if (typeof hero === 'string' && hero !== '') heroes.push(hero);
      } else if (typeof pick === 'string' && pick !== '') {
        heroes.push(pick);
      }
    }
  }
  return heroes;
}

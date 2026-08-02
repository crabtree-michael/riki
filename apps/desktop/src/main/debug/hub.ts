/**
 * The hub — every observation lands here, and a `DebugFrame` comes out.
 *
 * Pure: no Electron, no window, no clock of its own. It is the only stateful thing in the component
 * and the only thing worth testing, which is the same split `main/session/` and `main/overlay/`
 * already use.
 *
 * ## Push for edges, pull for state
 *
 * Ticks, turns and problems are **pushed**: they are events, they happen whether or not anyone is
 * looking, and missing one is missing the thing you opened the window to see. The world model, the
 * engine's switches, health and the counters are **pulled** at frame time through `DebugSources`,
 * because they are current-value questions that would otherwise be answered thirty times a second
 * into a buffer nobody reads.
 *
 * The consequence worth knowing: ticks accumulate as soon as the hub exists, so the last two
 * hundred are already there when the window opens. That is deliberate — the most useful moment to
 * open an inspector is just after something looked wrong.
 *
 * ## Everything is bounded
 *
 * `DEBUG_LIMITS` caps every list, and the two long text fields are truncated on the way in rather
 * than on the way out. A window left open for a forty-minute match holds a fixed amount of memory,
 * and `resetMatch()` drops the per-match half of it at `match_ended`.
 */

import type {
  DebugBus,
  DebugCount,
  DebugFrame,
  DebugProblem,
  DebugTick,
  DebugTurn,
} from '../../shared/debug.js';
import { DEBUG_LIMITS } from '../../shared/debug.js';
import type {
  DebugGateInput,
  DebugHub,
  DebugSources,
  DebugTickInput,
  DebugTurnOpenedInput,
} from './contracts.js';

/** How long a window the version-rate estimate covers. Short enough to react, long enough to settle. */
const RATE_WINDOW_MS = 3_000;

const EMPTY_BUS: DebugBus = { depth: 0, dropped: [], gaps: [] };

/**
 * Truncated with a marker rather than silently cut.
 *
 * A snapshot that ends mid-line and a snapshot that *was* rendered mid-line look identical
 * otherwise, and the second is a real failure the inspector exists to show.
 */
function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… ${String(text.length - max)} more characters`;
}

function push<T>(list: T[], item: T, cap: number): void {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
}

export function createDebugHub(): DebugHub {
  let sources: DebugSources = {};

  const ticks: DebugTick[] = [];
  const turns: DebugTurn[] = [];
  const problems: DebugProblem[] = [];

  let tickSeq = 0;
  let revision = 0;
  let emptyBriefs = 0;
  let totalTicks = 0;

  /**
   * The engine's state as of the most recent tick, of any kind.
   *
   * Held separately from `ticks` because it is updated by *every* tick and `ticks` deliberately
   * keeps only the ones with candidates in them: a match spends most of its time producing empty
   * ticks, and those are exactly the ones that carry the news that a cooldown expired.
   */
  let gateState: DebugGateInput | null = null;
  let gateStateAt: number | null = null;

  /** For the version rate: (at, version) pairs inside `RATE_WINDOW_MS`. */
  let versionMarks: { at: number; version: number }[] = [];

  /** Mutable so a transcript arriving after the fact can be joined to its turn. */
  const turnIndex = new Map<string, { -readonly [K in keyof DebugTurn]: DebugTurn[K] }>();

  function resetMatch(): void {
    ticks.length = 0;
    turns.length = 0;
    turnIndex.clear();
    versionMarks = [];
    tickSeq = 0;
    emptyBriefs = 0;
    totalTicks = 0;
    gateState = null;
    gateStateAt = null;
  }

  function versionsPerSecond(now: number, version: number): number {
    versionMarks.push({ at: now, version });
    versionMarks = versionMarks.filter((mark) => now - mark.at <= RATE_WINDOW_MS);
    const oldest = versionMarks[0];
    if (oldest === undefined) return 0;
    const span = now - oldest.at;
    if (span <= 0) return 0;
    return ((version - oldest.version) * 1_000) / span;
  }

  return {
    frame(now: number): DebugFrame {
      revision += 1;

      const session = sources.session?.();
      const world = sources.world?.(now);
      const gates = gateState;
      const counters = sources.counters?.();

      return {
        revision,
        at: now,

        session: {
          matchId: session?.matchId ?? null,
          coachingRoot: session?.coachingRoot ?? false,
          chipPhase: session?.chipPhase ?? 'unknown',
          chipVisible: session?.chipVisible ?? false,
          muted: session?.muted ?? false,
          coachMode: session?.coachMode ?? 'none',
          gates: {
            asOfMs: gateStateAt,
            quietMode: gates?.quietMode ?? false,
            agentSpeaking: gates?.agentSpeaking ?? false,
            playerSpeaking: gates?.playerSpeaking ?? false,
            mutedUntilMs: gates?.mutedUntilMs ?? null,
            unprompted: session?.unprompted ?? false,
            intensity: gates?.intensity ?? 0,
            intensityThreshold: gates?.intensityThreshold ?? 0,
            speakThreshold: gates?.speakThreshold ?? 0,
            lastSpokeAtMs: gates?.lastSpokeAtMs ?? null,
            globalCooldownMs: gates?.globalCooldownMs ?? 0,
            latched: gates?.latched ?? [],
            kindCooldowns: gates?.kindCooldowns ?? [],
          },
          health: {
            level: session?.healthLevel ?? 'unknown',
            summary: session?.healthSummary ?? 'no state subsystem',
            sources: (session?.sources ?? []).map((source) => ({
              id: source.id,
              state: source.state,
              reason: source.reason,
              lastObservationAgoMs:
                source.lastObservationAt === null ? null : now - source.lastObservationAt,
              restarts: source.restarts,
            })),
            bus: session === undefined ? EMPTY_BUS : { ...session.bus },
          },
        },

        world: {
          version: world?.version ?? 0,
          clock: world?.clock ?? null,
          paused: world?.paused ?? false,
          versionsPerSecond:
            world === undefined ? 0 : Math.round(versionsPerSecond(now, world.version) * 10) / 10,
          facts: (world?.facts ?? []).slice(0, DEBUG_LIMITS.facts),
          enemies: world?.enemies ?? [],
          derived: world?.derived ?? [],
        },

        ticks: [...ticks],
        turns: [...turns],

        counters: {
          detected: counters?.detected ?? [],
          suppressed: counters?.suppressed ?? [],
          spoken: counters?.spoken ?? 0,
          emptyBriefs,
          ticks: totalTicks,
        },

        problems: [...problems],
      };
    },

    recordTick(input: DebugTickInput): void {
      totalTicks += 1;
      // Before the early return: an empty tick is the only thing that reports a cooldown expiring
      // or a latch clearing, and those are two of the four things this panel exists to show.
      gateState = input.gates;
      gateStateAt = input.at;

      // A tick with no candidates is the overwhelmingly common case — eight detectors that all
      // answered "nothing is true right now" — and keeping them would push every interesting tick
      // out of a two-hundred-entry buffer within seconds. The count survives in `counters.ticks`,
      // which is what distinguishes "the engine is not running" from "the engine found nothing".
      if (input.candidates.length === 0) return;

      tickSeq += 1;
      push(
        ticks,
        {
          seq: tickSeq,
          at: input.at,
          clock: input.clock,
          worldVersion: input.worldVersion,
          candidates: input.candidates,
          decision: input.decision,
        },
        DEBUG_LIMITS.ticks,
      );
    },

    /**
     * The LLM coach's half of the Triggers panel.
     *
     * Not routed through `recordTick`, which drops a tick with no candidates — that rule exists
     * because the deterministic coach produces thousands of empty ticks a match and none of them
     * says anything. A decline from `packages/coach` is the opposite: it is the only thing that
     * coach ever says about a moment it passed on, so dropping it would leave the panel empty in
     * `llm` mode and look exactly like a coach that never ran.
     */
    recordDecline(reason: string, at: number, clock: number | null): void {
      totalTicks += 1;
      tickSeq += 1;
      push(
        ticks,
        {
          seq: tickSeq,
          at,
          clock,
          worldVersion: 0,
          candidates: [],
          decision: { speak: false, reason, key: null },
        },
        DEBUG_LIMITS.ticks,
      );
    },

    recordTurnOpened(input: DebugTurnOpenedInput): void {
      const turn = {
        turnId: input.turnId,
        at: input.at,
        clock: input.clock,
        cause: input.cause,
        eventId: input.eventId,
        salience: input.salience,
        snapshotText: clip(input.snapshotText, DEBUG_LIMITS.textChars),
        snapshotTokens: input.snapshotTokens,
        briefText: clip(input.briefText, DEBUG_LIMITS.textChars),
        briefTokens: input.briefTokens,
        briefSections: input.briefSections,
        briefOmitted: input.briefOmitted,
        briefEmpty: input.briefEmpty,
        outcome: 'open',
        agentSaid: null as string | null,
        playerSaidChars: null as number | null,
      };

      turnIndex.set(input.turnId, turn);
      push(turns, turn as DebugTurn, DEBUG_LIMITS.turns);
      // The index must not outlive the buffer, or a long match leaks one entry per turn — and a
      // late transcript would then be joined to a turn no frame can show.
      const live = new Set(turns.map((each) => each.turnId));
      for (const id of [...turnIndex.keys()]) if (!live.has(id)) turnIndex.delete(id);
    },

    recordTurnClosed(turnId: string, outcome: string): void {
      const turn = turnIndex.get(turnId);
      if (turn === undefined) return;
      turn.outcome = outcome;
    },

    recordAgentTranscript(turnId: string, text: string): void {
      const turn = turnIndex.get(turnId);
      if (turn === undefined) return;
      turn.agentSaid = clip(text, DEBUG_LIMITS.textChars);
    },

    recordPlayerTranscript(turnId: string, chars: number): void {
      const turn = turnIndex.get(turnId);
      if (turn === undefined) return;
      turn.playerSaidChars = chars;
    },

    recordProblem(origin: string, message: string, at: number): void {
      push(problems, { at, origin, message }, DEBUG_LIMITS.problems);
    },

    recordEmptyBrief(): void {
      emptyBriefs += 1;
    },

    observe(next: DebugSources): void {
      sources = next;
    },

    /**
     * A new match, so everything keyed to the old one goes.
     *
     * `problems` survives deliberately: a sidecar that panicked during the last match is exactly
     * the thing somebody is still trying to read when the next one starts.
     */
    resetMatch,

    dispose(): void {
      resetMatch();
      problems.length = 0;
      sources = {};
    },
  };
}

/** `ReadonlyMap` → the frame's array-of-pairs form, sorted so the display does not jitter. */
export function toCounts(entries: Iterable<readonly [string, number]>): readonly DebugCount[] {
  return [...entries]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key < b.key ? -1 : 1));
}

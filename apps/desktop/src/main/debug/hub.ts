/**
 * The hub — every observation lands here, and a `DebugFrame` comes out.
 *
 * Pure: no Electron, no window, no clock of its own. It is the only stateful thing in the component
 * and the only thing worth testing, which is the same split `main/session/` and `main/overlay/`
 * already use.
 *
 * ## Push for edges, pull for state
 *
 * Turns, problems and trace steps are **pushed**: they are events, they happen whether or not
 * anyone is looking, and missing one is missing the thing you opened the window to see. The world
 * model, the session and health are **pulled** at frame time through `DebugSources`, because they
 * are current-value questions that would otherwise be answered several times a second into a buffer
 * nobody reads.
 *
 * The consequence worth knowing: turns accumulate as soon as the hub exists, so the last forty are
 * already there when the window opens. That is deliberate — the most useful moment to open an
 * inspector is just after something looked wrong.
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
  DebugTraceStep,
  DebugTurn,
} from '../../shared/debug.js';
import { DEBUG_LIMITS } from '../../shared/debug.js';
import type { DebugHub, DebugSources, DebugTurnOpenedInput } from './contracts.js';

/** How long a window the version-rate estimate covers. Short enough to react, long enough to settle. */
const RATE_WINDOW_MS = 3_000;

/**
 * A trace line is one sentence. Longer than this is a payload, and a payload belongs in a turn.
 *
 * Clipped rather than refused so a message that grows a field later still shows what it can.
 */
const TRACE_MESSAGE_CHARS = 240;

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

  const turns: DebugTurn[] = [];
  const problems: DebugProblem[] = [];
  /** ADR-0039. Survives `resetMatch` — a scenario that ends the match must not erase its own trace. */
  const trace: DebugTraceStep[] = [];

  let traceSeq = 0;
  /** Non-null while a scenario run is in flight; every step in it carries `sinceRunMs`. */
  let traceRunStartedAt: number | null = null;

  let revision = 0;

  /** For the version rate: (at, version) pairs inside `RATE_WINDOW_MS`. */
  let versionMarks: { at: number; version: number }[] = [];

  /** Mutable so a transcript arriving after the fact can be joined to its turn. */
  const turnIndex = new Map<string, { -readonly [K in keyof DebugTurn]: DebugTurn[K] }>();

  function resetMatch(): void {
    turns.length = 0;
    turnIndex.clear();
    versionMarks = [];
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

      return {
        revision,
        at: now,

        session: {
          matchId: session?.matchId ?? null,
          matchSession: session?.matchSession ?? false,
          chipPhase: session?.chipPhase ?? 'unknown',
          chipVisible: session?.chipVisible ?? false,
          muted: session?.muted ?? false,
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

        turns: [...turns],
        problems: [...problems],
        actions: sources.actions?.() ?? [],
        trace: [...trace],
      };
    },

    recordTurnOpened(input: DebugTurnOpenedInput): void {
      const turn = {
        turnId: input.turnId,
        at: input.at,
        clock: input.clock,
        cause: input.cause,
        snapshotText: clip(input.snapshotText, DEBUG_LIMITS.textChars),
        snapshotTokens: input.snapshotTokens,
        snapshotOmitted: input.snapshotOmitted,
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

    recordTrace(stage: string, message: string, at: number): void {
      traceSeq += 1;
      push(
        trace,
        {
          at,
          seq: traceSeq,
          stage,
          message: clip(message, TRACE_MESSAGE_CHARS),
          sinceRunMs: traceRunStartedAt === null ? null : at - traceRunStartedAt,
        },
        DEBUG_LIMITS.trace,
      );
    },

    markTraceRun(startedAt: number | null): void {
      traceRunStartedAt = startedAt;
    },

    clearTrace(): void {
      trace.length = 0;
    },

    observe(next: DebugSources): void {
      sources = next;
    },

    /**
     * A new match, so everything keyed to the old one goes.
     *
     * `problems` and `trace` survive deliberately: a sidecar that panicked during the last match is
     * exactly the thing somebody is still trying to read when the next one starts, and a scenario
     * that ends the match must not erase its own trace.
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

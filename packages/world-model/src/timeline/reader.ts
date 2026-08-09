/**
 * Reading a recording back at an instant, in bounded work.
 *
 * A recording (`record/`) is the agent's memory, and this is the half that remembers rather than
 * the half that writes. `conversational-architecture.md` §6 states the contract in one sentence:
 * *seek the nearest keyframe at or before `t` and replay observations forward to the instant —
 * never more than one keyframe interval of replay regardless of match length.*
 *
 * ## Why replay at all, rather than keyframe more often
 *
 * A keyframe is the whole model, and the whole model is a few hundred kilobytes of JSON. Writing
 * one per observation would be a 2–8 Hz stream of them and would put the recording well past the
 * size budget §6 gives it. Writing one every 30 s and replaying the gap is microseconds of work,
 * and — the property that actually matters — **flat in match length**. A forty-minute match answers
 * a question about minute two exactly as fast as a question about minute thirty-nine.
 *
 * ## The bound is the history window, not the keyframe interval
 *
 * §6 says one keyframe interval and this reads back further than that, deliberately.
 *
 * A keyframe does not carry the two ring histories — `record/keyframe.ts` says why, and is right.
 * But `objectives.recently_lost` is recovered from the delta ring rather than read from a field
 * (`tools/buildings.ts`), it looks back `DEFAULT_HISTORY_WINDOW_SECONDS`, and it is a bare array
 * with no `unknown` branch to retreat to. So a reconstruction that replayed thirty seconds would
 * hand the model an empty array meaning *"nothing has fallen"* — spoken aloud, every time, about a
 * match in which two towers had. That is the exact failure mode ADR-0043 exists to prevent, arrived
 * at from the other direction.
 *
 * So the anchor is the newest keyframe at or before `t − historyWindowSeconds`, the replay rebuilds
 * the ring as it goes (`deltas.compute` and `history.push`, the same two lines
 * `WorldModelStore.commit` runs), and the bound becomes `historyWindow + keyframeInterval` — five
 * and a half minutes, ~2,600 `fuse` calls at 8 Hz, measured at a few milliseconds and asserted by a
 * test. Still a constant, still flat in match length; a larger constant than §6 assumed, for a
 * field §6 did not know was recoverable. ADR-0048.
 *
 * ## The reconstruction is the real store, not an approximation of it
 *
 * Everything here runs the *same* `fuse` against the *same* `FusionPolicies`, from a state
 * `deserialiseWorldState` produced, at the *same* `now` the live store was given — `startedAt +
 * atMs`, which is why `record/format.ts` keeps both. Nothing re-derives, nothing interpolates and
 * nothing guesses; precedence, the confidence gate and ageing all make the decisions they made
 * live. That is what lets the acceptance test assert field by field against the store rather than
 * approximately, and it is the only reason a `world_at` answer can be trusted the way a `my_state`
 * answer is.
 *
 * Two things a reconstruction does *not* have, both by design and both stated rather than hidden:
 * the two ring histories, which `keyframe.ts` deliberately does not carry, and the delta tape,
 * which is the recording itself.
 *
 * ## No I/O
 *
 * `openTimeline` takes the file's contents, not its path. `record/file-sink.ts` remains the one
 * file in this package that touches a disk (see the package header), and a reader that opened
 * files would make that two — for no gain, since the caller with the `dataDir` is the composition
 * root either way.
 */

import type { UnknownFact } from '@riki/protocol';
import { UNKNOWN_REASONS } from '@riki/protocol';

import type { DerivedRegistry } from '../derived/registry.js';
import { createDerivedRegistry } from '../derived/registry.js';
import type { ConfidenceGate } from '../fusion/confidence.js';
import { createConfidenceGate } from '../fusion/confidence.js';
import type { PrecedencePolicy } from '../fusion/precedence.js';
import { createPrecedencePolicy } from '../fusion/precedence.js';
import type { StalenessPolicy } from '../fusion/staleness.js';
import { createStalenessPolicy } from '../fusion/staleness.js';
import { defaultDerivedRules } from '../derived/rules/index.js';
import type { FusionPolicies } from '../fusion/reducer.js';
import { fuse } from '../fusion/reducer.js';
import { createDeltaComputer } from '../history/delta.js';
import type { Observation, SourceId } from '../observation.js';
import type { KeyframeLine, ObservationLine, RecordLine } from '../record/format.js';
import { parseRecordLines } from '../record/format.js';
import { deserialiseWorldState } from '../record/keyframe.js';
import { DEFAULT_KEYFRAME_INTERVAL_MS } from '../record/recorder.js';
import type { WorldSnapshot } from '../snapshot.js';
import { createSnapshot } from '../snapshot.js';
import type { WorldState } from '../state.js';
import { DEFAULT_HISTORY_WINDOW_SECONDS, emptyState } from '../state.js';
import type { GameClock, MonoMs } from '../time.js';
import { asGameClock, asMonoMs } from '../time.js';

/**
 * A moment the recording can actually answer about.
 *
 * One per line that changed or captured the model, which is every line but the header. A question
 * about a moment between two of them is answered at the earlier one, because that is the last
 * thing anybody observed — inventing a state for the gap is the one thing a recording must not do.
 */
export interface TimelineInstant {
  /** Milliseconds since the recording opened. The axis `seconds_ago` is measured on. */
  readonly atMs: number;
  /** The monotonic reading the live store was given for this line, so ages come out unchanged. */
  readonly now: MonoMs;
  /** `map.clock_time` as of this line, or null before the horn. The axis `clock` is measured on. */
  readonly clock: GameClock | null;
  readonly lineIndex: number;
}

/** The keyframe a reconstruction started from, and how far it had to walk. */
export interface TimelineAnchor {
  readonly atMs: number;
  readonly lineIndex: number;
  /** `open`, `interval`, `match_ended`, `clock_discontinuity` … or `none` — see `reconstruct`. */
  readonly reason: string;
  readonly version: number;
}

export interface Reconstruction {
  /** The same shape `WorldModelStore.snapshot()` returns, as of `at`. */
  readonly snapshot: WorldSnapshot;
  readonly at: TimelineInstant;
  readonly from: TimelineAnchor;
  /** Observation lines fused. This is the number the bounded-work claim is about. */
  readonly replayed: number;
  /** Keyframe leaves that named no field or carried no readable fact. Never silent. */
  readonly skipped: readonly string[];
  /** Candidates the reducer refused during the replay, summed. Live, these were counted too. */
  readonly rejected: number;
}

/**
 * Which moment, on which axis.
 *
 * Two axes and not one, because the two questions are genuinely different and only one of them
 * survives a pause. `clock` is match time, which freezes when the game does; `secondsAgo` is
 * wall time, which does not, and which is the only axis that exists at all during the draft.
 * Collapsing them would mean picking one and being quietly wrong about the other — see ADR-0048.
 */
export type TimelineTarget =
  | { readonly clock: GameClock }
  | {
      /**
       * Seconds before the **last line this timeline holds**, which for a recording of a match in
       * progress is within one POST of now. A live caller therefore has to open the timeline over
       * the current contents of the file; one opened at match start and kept would answer "thirty
       * seconds ago" about the match's first thirty seconds forever.
       */
      readonly secondsAgo: number;
    };

export interface Timeline {
  readonly matchId: string | null;
  /** The monotonic reading `atMs` counts from, recovered from the header. */
  readonly startedAt: MonoMs;
  readonly keyframeIntervalMs: number;
  readonly first: TimelineInstant | null;
  readonly last: TimelineInstant | null;
  readonly keyframes: number;
  /** The file ended mid-line — a `SIGKILL`. Everything before it is here and is intact. */
  readonly truncated: boolean;
  readonly malformed: number;

  /**
   * The model as of `target`, or the reason there is no answer.
   *
   * An `UnknownFact` rather than null or a throw, for the reason ADR-0043 gives: "before the
   * recording starts" is an ordinary answer to an ordinary question, and it is one the model can
   * say out loud. `isUnknown` from @riki/protocol discriminates it.
   */
  at(target: TimelineTarget): Reconstruction | UnknownFact;
}

/**
 * The policies a reconstruction fuses with.
 *
 * Deliberately the same set `createWorldModelStore` takes: a replay under different precedence
 * from the run that recorded it would reconstruct a match that never happened, and the failure
 * would look like a subtle disagreement rather than an error. A caller that configures the store
 * must pass the same object here.
 */
export interface TimelineOptions {
  readonly precedence?: PrecedencePolicy;
  readonly confidence?: ConfidenceGate;
  readonly staleness?: StalenessPolicy;
  readonly derived?: DerivedRegistry;
  readonly historyWindowSeconds?: number;
}

/** A recording's text — the whole file, or as much of it as survived. */
export function openTimeline(contents: string, opts: TimelineOptions = {}): Timeline {
  const parsed = parseRecordLines(contents);
  return createTimeline(parsed.lines, parsed.truncated, parsed.malformed, opts);
}

export function createTimeline(
  lines: readonly RecordLine[],
  truncated: boolean,
  malformed: number,
  opts: TimelineOptions = {},
): Timeline {
  const policies: FusionPolicies = {
    precedence: opts.precedence ?? createPrecedencePolicy(),
    confidence: opts.confidence ?? createConfidenceGate(),
    staleness: opts.staleness ?? createStalenessPolicy(),
  };
  const derived =
    opts.derived ?? createDerivedRegistry(defaultDerivedRules({ staleness: policies.staleness }));
  const historyWindowSeconds = opts.historyWindowSeconds ?? DEFAULT_HISTORY_WINDOW_SECONDS;

  const header = lines.find((line) => line.kind === 'header');
  const startedAt = asMonoMs(header?.startedAt ?? 0);
  const keyframeIntervalMs =
    header !== undefined && header.keyframeIntervalMs > 0
      ? header.keyframeIntervalMs
      : DEFAULT_KEYFRAME_INTERVAL_MS;

  /**
   * Every seekable moment, and every keyframe index, walked once at open.
   *
   * The alternative — scanning the line array per query — would make a `world_at` call O(match)
   * in exactly the way the keyframe scheme exists to avoid, and would do it in the leg that runs
   * inside a spoken sentence.
   */
  const moments: TimelineInstant[] = [];
  const keyframeIndices: number[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (line.kind === 'header') continue;
    if (line.kind === 'keyframe') keyframeIndices.push(lineIndex);
    moments.push({
      atMs: line.atMs,
      now: asMonoMs(startedAt + line.atMs),
      clock: line.clock === null ? null : asGameClock(line.clock),
      lineIndex,
    });
  }

  const first = moments[0] ?? null;
  const last = moments.at(-1) ?? null;

  /**
   * The keyframe to replay from: the newest one that is still old enough to rebuild the delta ring.
   *
   * The obvious anchor is the newest keyframe at or before the instant, and it is not enough — see
   * the header. `notAfterMs` is the instant minus the history window, so the replay covers the ring
   * as well as the facts. When nothing is that old, the earliest keyframe available is the answer:
   * the recording is younger than the window, so there is nothing before it to miss.
   */
  const anchorFor = (lineIndex: number, notAfterMs: number): number => {
    let low = 0;
    let high = keyframeIndices.length - 1;
    let found = -1;
    let earliest = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = keyframeIndices[mid] ?? 0;
      if (candidate > lineIndex) {
        high = mid - 1;
        continue;
      }
      if (earliest < 0 || candidate < earliest) earliest = candidate;
      if ((lines[candidate]?.atMs ?? 0) <= notAfterMs) {
        found = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found >= 0) return found;
    // The binary search above only visits a logarithmic slice, so `earliest` is not reliably the
    // first keyframe — take it directly when nothing qualified.
    const first = keyframeIndices[0];
    return first !== undefined && first <= lineIndex ? first : -1;
  };

  /**
   * Rehydrate, replay, snapshot.
   *
   * The version arithmetic and the delta push mirror `WorldModelStore.commit` exactly — bump on a
   * change of state identity, diff against the state being replaced, push the delta onto the ring.
   * Both matter. The version is the one number a holder of an old snapshot can use to tell that it
   * is old; the ring is where `objectives.recently_lost` comes from, and the header says what
   * happens without it.
   */
  const reconstruct = (moment: TimelineInstant): Reconstruction => {
    const anchorIndex = anchorFor(moment.lineIndex, moment.atMs - historyWindowSeconds * 1000);
    const keyframe = anchorIndex < 0 ? null : (lines[anchorIndex] as KeyframeLine);

    let state: WorldState;
    let skipped: readonly string[] = [];
    if (keyframe === null) {
      // No keyframe before this line at all: a file whose head was lost, or one somebody
      // assembled by hand. Replaying the prefix from empty is the honest fallback, and it is
      // reported through `from.reason` rather than quietly costing the bounded-work guarantee.
      state = emptyState(startedAt, { historyWindowSeconds });
    } else {
      const read = deserialiseWorldState(keyframe.state, { historyWindowSeconds });
      state = read.state;
      skipped = read.skipped;
    }

    const deltas = createDeltaComputer();
    let replayed = 0;
    let rejected = 0;
    for (let index = anchorIndex + 1; index <= moment.lineIndex; index += 1) {
      const line = lines[index];
      if (line === undefined || line.kind === 'header' || line.kind === 'keyframe') continue;
      const now = asMonoMs(startedAt + line.atMs);
      const outcome = fuse(state, observationOf(line), now, policies);
      replayed += 1;
      rejected += outcome.rejections.length;
      if (outcome.state === state) continue;
      const versioned: WorldState = { ...outcome.state, version: state.version + 1 };
      const delta = deltas.compute(state, versioned);
      state = versioned;
      state.history.push(delta, delta.atGameClock, now);
    }

    return {
      snapshot: createSnapshot({
        state,
        now: moment.now,
        // The same expression `WorldModelStore.snapshot` uses. Taking the clock from the *line*
        // instead would be a second source of truth for it, and the two differ for any line the
        // reducer rejected outright.
        clock: state.meta.clock?.value ?? null,
        staleness: policies.staleness,
        derived,
      }),
      at: moment,
      from: {
        atMs: keyframe?.atMs ?? 0,
        lineIndex: anchorIndex,
        reason: keyframe?.reason ?? 'none',
        version: keyframe?.version ?? 0,
      },
      replayed,
      skipped,
      rejected,
    };
  };

  return {
    matchId: header?.matchId ?? null,
    startedAt,
    keyframeIntervalMs,
    first,
    last,
    keyframes: keyframeIndices.length,
    truncated,
    malformed,

    at(target: TimelineTarget): Reconstruction | UnknownFact {
      if (last === null) return { unknown: UNKNOWN_REASONS.beforeRecording };

      if ('clock' in target) {
        // Only clocked moments are candidates: a draft line has no clock, and treating its
        // absence as zero would answer a question about 0:00 with the hero-selection screen.
        const clocked = moments.filter((moment) => moment.clock !== null);
        if (clocked.length === 0) return { unknown: UNKNOWN_REASONS.noClockYet };
        const found = lastWhere(clocked, (moment) => (moment.clock ?? 0) <= target.clock);
        return found === null ? { unknown: UNKNOWN_REASONS.beforeRecording } : reconstruct(found);
      }

      const targetAtMs = last.atMs - target.secondsAgo * 1000;
      const found = lastWhere(moments, (moment) => moment.atMs <= targetAtMs);
      return found === null ? { unknown: UNKNOWN_REASONS.beforeRecording } : reconstruct(found);
    },
  };
}

/**
 * The last entry satisfying a monotone predicate, by binary search.
 *
 * Monotone because both axes are non-decreasing across a recording: `atMs` by construction, and
 * the clock because it only ever advances or is frozen by a pause. A clock that jumps *backwards*
 * is a `clock_discontinuity`, which the composition root answers with a reset and a fresh
 * keyframe — so within one recording the sequence is still non-decreasing on either side of it,
 * and a search landing on the wrong side of a reset would reconstruct facts the live model had
 * already thrown away.
 */
function lastWhere<T>(entries: readonly T[], holds: (entry: T) => boolean): T | null {
  let low = 0;
  let high = entries.length - 1;
  let found: T | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid] as T;
    if (holds(entry)) {
      found = entry;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * A line back into the observation the live store was handed.
 *
 * Every field is the one that was recorded, including `seq` and `receivedAt` — the reducer stamps
 * facts with `receivedAt`, so an observation rebuilt with anything else would produce facts whose
 * ages differ from the ones the live model held, which is the whole thing being asserted.
 *
 * A chat line arrives here with its text already gone (`redactForDisk`), which costs nothing the
 * model reads: the chat ring is not part of a keyframe and not addressable by `FieldPath`.
 */
function observationOf(line: ObservationLine): Observation {
  return {
    kind: line.kind,
    sourceId: line.sourceId as SourceId,
    seq: line.seq,
    receivedAt: asMonoMs(line.receivedAt),
    payload: line.body,
    v: line.v,
  };
}

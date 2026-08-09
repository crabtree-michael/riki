/**
 * A `WorldState`, flattened to JSON and back.
 *
 * A keyframe exists so that `world_at(t)` is bounded work: seek the nearest keyframe at or before
 * `t`, replay observations forward, and never touch more than one keyframe interval of the file
 * however long the match ran (conversational-architecture.md §6).
 *
 * ## The representation is `flattenFacts`, not the object graph
 *
 * `WorldState` is a tree of `Fact` leaves with two `Map`s in the middle, and `JSON.stringify` turns
 * a `Map` into `{}`. Rather than mirror the tree with a bespoke encoder — a second declaration of
 * where `self.health` lives, which `state.ts` exists to prevent — a keyframe is the flat
 * `FieldPath → Fact` map that `flattenFacts` already produces, and reading one back is
 * `emptyState` plus a `writeFact` per entry.
 *
 * That is not merely shorter. It round-trips *by construction*: every leaf the model can hold is
 * reachable by a `FieldPath` (that is `parsePath`'s job), so a field added to `WorldState` is
 * carried by a keyframe with no change here. A bespoke encoder would silently stop recording it.
 *
 * ## What a keyframe does not carry, and why
 *
 * The two ring histories. `history` is the delta tape, which the recording *is* — replaying the
 * observations between two keyframes reconstructs it, and writing it as well would put a bounded
 * five-minute window on disk beside an unbounded one. `chat` is other people's words: dota2 §7
 * classes every chat line `sensitive`, REPO_SKELETON §7.2 requires the toggles that widen
 * retention to ship off, and a local file is one upload away from being egress. So a rehydrated
 * state has empty rings, and the reader is told rather than left to discover it.
 */

import type { Fact, FactSource } from '../fact.js';
import { asConfidence } from '../fact.js';
import type { EmptyStateOptions, FieldPath, WorldState } from '../state.js';
import { emptyState, flattenFacts, writeFact } from '../state.js';
import { asGameClock, asMonoMs } from '../time.js';

/** Bumped independently of the line format: a keyframe can change while the envelope does not. */
export const KEYFRAME_FORMAT_VERSION = 1;

export interface SerialisedFact {
  readonly value: unknown;
  readonly source: FactSource;
  readonly confidence: number;
  readonly observedAt: number;
  readonly atGameClock: number | null;
  readonly origin?: string;
}

export interface SerialisedWorldState {
  readonly format: number;
  readonly version: number;
  /** `meta.lastUpdatedAt`, which is a stamp rather than a `Fact` and so is not in `facts`. */
  readonly lastUpdatedAt: number;
  /** Keyed by `FieldPath`. Absent means never observed — the distinction the model is built on. */
  readonly facts: Readonly<Record<string, SerialisedFact>>;
}

const FACT_SOURCES: readonly string[] = ['gsi', 'log', 'cv', 'api', 'derived'];

export function serialiseWorldState(state: WorldState): SerialisedWorldState {
  const facts: Record<string, SerialisedFact> = {};
  for (const [path, fact] of flattenFacts(state)) {
    facts[path] = serialiseFact(fact);
  }

  return {
    format: KEYFRAME_FORMAT_VERSION,
    version: state.version,
    lastUpdatedAt: state.meta.lastUpdatedAt,
    facts,
  };
}

export interface KeyframeReadResult {
  readonly state: WorldState;
  /**
   * Entries that named no leaf, or carried no readable fact. Returned rather than thrown: one bad
   * field in a recovered file should cost that field, not the match — and returned rather than
   * dropped, because a reader that silently loses a leaf is the failure `readFact` is designed
   * around.
   */
  readonly skipped: readonly string[];
}

/**
 * A `WorldState` from a keyframe, with empty rings.
 *
 * `version` and `lastUpdatedAt` are restored after the writes because `emptyState` supplies its
 * own, and a rehydrated state that reports a different version from the one recorded would break
 * the only thing a holder of an old snapshot can use to tell that it is old.
 */
export function deserialiseWorldState(
  serialised: SerialisedWorldState,
  opts: EmptyStateOptions = {},
): KeyframeReadResult {
  const lastUpdatedAt = asMonoMs(
    typeof serialised.lastUpdatedAt === 'number' ? serialised.lastUpdatedAt : 0,
  );
  const skipped: string[] = [];

  let state = emptyState(lastUpdatedAt, opts);
  // Read through `unknown`: this object came off a disk, so the declared type is a claim about
  // what was written rather than a guarantee about what was read back.
  const encoded: unknown = serialised.facts;
  const entries =
    typeof encoded === 'object' && encoded !== null && !Array.isArray(encoded)
      ? Object.entries(encoded)
      : [];
  for (const [path, raw] of entries) {
    const fact = deserialiseFact(raw);
    if (fact === null) {
      skipped.push(path);
      continue;
    }
    const next = writeFact(state, path as FieldPath, fact);
    // `writeFact` returns the state unchanged for a path that names no leaf, which is exactly the
    // typo case `parsePath` exists to reject. Counting it here is what makes it visible.
    if (next === state) skipped.push(path);
    state = next;
  }

  return {
    state: {
      ...state,
      version: typeof serialised.version === 'number' ? serialised.version : 0,
      meta: { ...state.meta, lastUpdatedAt },
    },
    skipped,
  };
}

function serialiseFact(fact: Fact<unknown>): SerialisedFact {
  const base = {
    value: fact.value,
    source: fact.source,
    confidence: fact.confidence as number,
    observedAt: fact.observedAt as number,
    atGameClock: fact.atGameClock === null ? null : (fact.atGameClock as number),
  };
  return fact.origin === undefined ? base : { ...base, origin: fact.origin };
}

/**
 * A fact, or null if the JSON is not one.
 *
 * `asConfidence` throws outside 0–1 rather than clamping, and that rule holds on the way in from
 * disk as well: a corrupted 1.4 must not become maximum confidence in a coach's mouth. Here the
 * throw is caught and the leaf dropped, because the alternative is losing the match to one byte.
 */
function deserialiseFact(raw: unknown): Fact<unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const source = record.source;
  const confidence = record.confidence;
  const observedAt = record.observedAt;
  const atGameClock = record.atGameClock;

  if (typeof source !== 'string' || !FACT_SOURCES.includes(source)) return null;
  if (typeof confidence !== 'number' || typeof observedAt !== 'number') return null;
  if (!('value' in record)) return null;

  let branded;
  try {
    branded = asConfidence(confidence);
  } catch {
    return null;
  }

  const base = {
    value: record.value,
    source: source as FactSource,
    confidence: branded,
    observedAt: asMonoMs(observedAt),
    atGameClock: typeof atGameClock === 'number' ? asGameClock(atGameClock) : null,
  };
  return typeof record.origin === 'string' ? { ...base, origin: record.origin } : base;
}

/**
 * The vocabulary shared by every tier of this package.
 *
 * Tiers 1, 2 and 3 all speak about time, staleness, heroes and privacy, and they must speak about
 * them in exactly the same terms — a `Staleness` that means one thing to the snapshot renderer and
 * another to a tool result is how Riki ends up hedging a fact in one place and stating it flatly in
 * the other. So there is one declaration of each, here, and the tier directories import it.
 *
 * See docs/design/context-and-memory-architecture.md §3 and §11.
 *
 * ⚠ Transitional. Every branded scalar below belongs to @riki/protocol per REPO_SKELETON.md §4;
 * that package is step 2 and still empty. Collecting them in one file is what makes that a
 * single-file change later instead of four. `Observed<T>` and `Staleness` are owned by
 * state-capture-architecture.md §3 and §5.5 and are declared structurally here for the same reason.
 */

/** Every subscription in this package returns its own disposer. */
export type Unsubscribe = () => void;

// -----------------------------------------------------------------------------------------------
// Time
// -----------------------------------------------------------------------------------------------

/** Local monotonic milliseconds. Never wall-clock: a fact's age must not move when NTP steps. */
export type MonoMs = number & { readonly __brand: 'MonoMs' };

/** Dota's `map.clock_time`, in seconds. Negative before the horn. Frozen while paused. */
export type GameClock = number & { readonly __brand: 'GameClock' };

/** Injected everywhere, so every deadline, budget and rate window is deterministic in a Tier 1 test. */
export interface Clock {
  now(): MonoMs;
}

// -----------------------------------------------------------------------------------------------
// Identity
// -----------------------------------------------------------------------------------------------

/** One agent turn. Budgets, memos, cancellation and ledger grouping are all scoped to it. */
export type TurnId = string & { readonly __brand: 'TurnId' };

/** The session's id for one function call. Opaque, off the wire, and the join key for a command. */
export type CallId = string & { readonly __brand: 'CallId' };

/** One match. The ledger is keyed by it; durable memory deliberately is not (ADR-0013). */
export type MatchId = string & { readonly __brand: 'MatchId' };

export type HeroId = string & { readonly __brand: 'HeroId' };
export type ItemId = string & { readonly __brand: 'ItemId' };

/** An event type from `packages/events` (dota2 §6.4), named here without importing that package. */
export type EventId = string & { readonly __brand: 'EventId' };

export type Role = 'carry' | 'mid' | 'offlane' | 'soft_support' | 'hard_support' | 'unknown';

// -----------------------------------------------------------------------------------------------
// Observation — provenance, confidence, age
// -----------------------------------------------------------------------------------------------

/** state-capture-architecture.md §5.5. */
export type Staleness = 'fresh' | 'aging' | 'stale' | 'expired';

export type Provenance = 'gsi' | 'log' | 'cv' | 'api' | 'derived';

/**
 * What every tier renders from, and never a bare value.
 *
 * Mirrors `WorldSnapshot.get()` (state-capture §7.1), which returns the staleness alongside the
 * fact for exactly this reason: the annoyance at every call site is the reminder that a 30-second-old
 * CV position is a hypothesis. dota2 §4 rule 3 calls presenting one as certainty the worst outcome
 * the product has, and `AgeFormatter` (../render) is the single function that enforces it.
 */
export interface Observed<T> {
  readonly value: T;
  readonly staleness: Staleness;
  readonly ageMs: number;
  readonly confidence: number;
  readonly source: Provenance;
}

// -----------------------------------------------------------------------------------------------
// Privacy
// -----------------------------------------------------------------------------------------------

/**
 * The second of the two independent gates on chat text; the first is at the source, where the log
 * tailer tags it `sensitive` (state-capture §4.2). Defaults are off and are asserted by test
 * (REPO_SKELETON.md §7.2), because dota2 §7's ⚠ row is other people's words.
 */
export interface PrivacyPolicy {
  readonly allowChatText: boolean;
  readonly allowPlayerNames: boolean;
}

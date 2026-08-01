/**
 * The memory vocabulary — four spans, from one turn to across matches.
 *
 * The model's context window is a *cache of the tail* of the ledger, not a record: it truncates
 * oldest-first, gives no queryable account of what it dropped, and dies with the session
 * (realtime §5). ADR-0012 is why Riki keeps its own.
 *
 * See docs/design/context-and-memory-architecture.md §6 and §7. Declarations only.
 */

import type {
  CallId,
  EventId,
  GameClock,
  HeroId,
  ItemId,
  MonoMs,
  Role,
  TurnId,
} from '../common/types.js';
import type { RenderedText, SectionId } from '../render/types.js';

// -----------------------------------------------------------------------------------------------
// The ledger (§3.3, §6.2)
// -----------------------------------------------------------------------------------------------

/** A stable position in the ledger. Monotonic, so ordering is comparison rather than lookup. */
export type LedgerRef = number & { readonly __brand: 'LedgerRef' };

export type TurnCauseRecord =
  | { readonly by: 'player'; readonly gesture: 'push_to_talk' | 'wake' }
  | { readonly by: 'trigger'; readonly event: EventId; readonly salience: number }
  | { readonly by: 'system'; readonly reason: 'match_started' | 'rehydrate' };

/**
 * One closed union, and the closure is the point: §6.5's privacy table is a property of this type
 * rather than of the code that writes it.
 *
 * `turn_closed` carrying `'silent'` is not bookkeeping. `packages/events` decides *not* to speak
 * far more often than it decides to speak (dota2 §6.4), and the record of a suppressed trigger is
 * what lets the cooldown and novelty gates reason about pressure rather than only about utterances
 * — and what makes "Riki has been quiet for nine minutes" something anybody can notice.
 */
export type LedgerEntry =
  | {
      readonly kind: 'turn_opened';
      readonly turnId: TurnId;
      readonly cause: TurnCauseRecord;
      readonly at: MonoMs;
      readonly clock: GameClock | null;
    }
  | {
      readonly kind: 'snapshot';
      readonly turnId: TurnId;
      readonly rendered: RenderedText;
      readonly sections: readonly SectionId[];
      readonly at: MonoMs;
    }
  | {
      readonly kind: 'agent_said';
      readonly turnId: TurnId;
      readonly transcript: string;
      /** From the trigger, never from the text. Nothing here classifies natural language (§6.3). */
      readonly topics: readonly AdviceTopic[];
      readonly at: MonoMs;
    }
  | {
      readonly kind: 'player_said';
      readonly turnId: TurnId;
      readonly transcript: string;
      readonly at: MonoMs;
    }
  | {
      readonly kind: 'command';
      readonly turnId: TurnId;
      readonly callId: CallId;
      readonly name: string;
      readonly result: RenderedText;
      readonly status: string;
      readonly at: MonoMs;
    }
  | {
      readonly kind: 'summary';
      readonly replaces: readonly LedgerRef[];
      readonly rendered: RenderedText;
      readonly at: MonoMs;
    }
  | {
      readonly kind: 'turn_closed';
      readonly turnId: TurnId;
      readonly outcome: TurnOutcome;
      readonly at: MonoMs;
    };

export type TurnOutcome = 'spoke' | 'silent' | 'cancelled';

/**
 * `api_truncation` is a bug, not a condition: it means the low-water mark or the token counter is
 * wrong and the API reached the budget before we did. A non-zero count should alert, exactly like
 * the `internal` row of the command failure taxonomy.
 */
export type DropReason = 'planned' | 'api_truncation' | 'session_lost';

// -----------------------------------------------------------------------------------------------
// Coaching memory (§6.3)
// -----------------------------------------------------------------------------------------------

/** Closed: a topic is an event type or a subject, never free text. */
export type AdviceTopic =
  | { readonly of: 'event'; readonly event: EventId }
  | { readonly of: 'item'; readonly item: ItemId }
  | { readonly of: 'hero'; readonly hero: HeroId }
  | { readonly of: 'objective'; readonly objective: 'roshan' | 'tower' | 'rune' | 'stack' };

/**
 * Whether advice was followed is **observed in the world model**, not inferred from the
 * conversation. If Riki said "you can afford a BKB" and a BKB appears within *(tunable: 90 s)*,
 * that is `followed`; gold spent elsewhere is `ignored`. The player saying "yeah okay" is worth
 * nothing; the item is worth everything.
 */
export type AdviceResponse = 'unknown' | 'followed' | 'ignored' | 'dismissed';

export interface AdviceRecord {
  readonly topic: AdviceTopic;
  readonly firstAt: GameClock;
  readonly lastAt: GameClock;
  readonly count: number;
  readonly response: AdviceResponse;
}

// -----------------------------------------------------------------------------------------------
// Durable memory (§6.4, ADR-0013)
// -----------------------------------------------------------------------------------------------

export type PatternId = string & { readonly __brand: 'PatternId' };
export type PreferenceKey = string & { readonly __brand: 'PreferenceKey' };

/**
 * **A closed union with no free-text field anywhere in it.** Every `string` below is an id or an
 * enum, so chat lines, voice transcripts, player names and model output are not representable and
 * cannot be written by mistake. That is the privacy guarantee of ADR-0013 — the type, not a rule
 * someone has to remember — and the Tier 1 test for it is that adding an arm with a free-text
 * field fails.
 *
 * There is no key for anyone but the local player. Other people appear as hero ids, which are not
 * people.
 */
export type PlayerObservation =
  | {
      readonly kind: 'hero_played';
      readonly hero: HeroId;
      readonly role: Role;
      readonly result: 'win' | 'loss' | 'unknown';
      readonly at: number;
    }
  | {
      readonly kind: 'advice_response';
      readonly topic: AdviceTopic;
      readonly response: AdviceResponse;
      readonly at: number;
    }
  | { readonly kind: 'pattern'; readonly pattern: PatternId; readonly at: number }
  | { readonly kind: 'preference'; readonly key: PreferenceKey; readonly value: string };

export interface HeroFamiliarity {
  readonly hero: HeroId;
  readonly matches: number;
  readonly wins: number;
  readonly lastPlayedAt: number;
}

export interface AdviceTendency {
  readonly followed: number;
  readonly ignored: number;
}

export interface PatternCount {
  readonly pattern: PatternId;
  readonly count: number;
  readonly lastAt: number;
}

/**
 * What OpenDota cannot know: how this player responds to *this coach*. Three lines in the preamble,
 * and most of the difference between a coach and a dashboard.
 *
 * A version mismatch or a parse failure yields an empty one of these. Nothing is load-bearing on
 * it — an empty memory is a fully working coach — which is what makes discarding the right default.
 */
export interface PlayerMemory {
  readonly schemaVersion: number;
  readonly heroes: ReadonlyMap<HeroId, HeroFamiliarity>;
  readonly adviceTendency: ReadonlyMap<string, AdviceTendency>;
  readonly patterns: readonly PatternCount[];
}

// -----------------------------------------------------------------------------------------------
// The context window (§7)
// -----------------------------------------------------------------------------------------------

export interface WindowBudget {
  /** ~28,672 usable after the prefix (realtime §5). */
  readonly capTokens: number;
  /** Compact when occupancy crosses this *(tunable: 0.75)*, not when the window is full. */
  readonly lowWaterMark: number;
  /** Compact down to this *(tunable: 0.55)* — trim aggressively but rarely (realtime §5). */
  readonly targetAfter: number;
  /** Turns of conversation that are never dropped *(tunable: 6)*. */
  readonly keepLastTurns: number;
}

export interface WindowState {
  readonly estimatedTokens: number;
  readonly inWindow: readonly LedgerRef[];
  readonly lastCompactedAt: MonoMs | null;
}

/** What the session actually reports, when it reports anything. Null is unknown, never guessed. */
export interface WindowUsage {
  readonly reportedTokens: number;
  readonly at: MonoMs;
}

/**
 * A value, not a series of calls: this package decides what should leave the window and what should
 * replace it; `packages/realtime` decides how to make that true.
 *
 * `reason: 'forced'` is above the cap, where a cache bust during a teamfight is still better than
 * the API truncating oldest-first — which would take the cached prefix, so Riki would forget who it
 * is before it forgot what it just said.
 */
export interface WindowPlan {
  readonly drop: readonly LedgerRef[];
  readonly replace: readonly { readonly refs: readonly LedgerRef[]; readonly with: RenderedText }[];
  readonly estimatedTokensAfter: number;
  readonly reason: 'low_water' | 'quiet_moment' | 'forced';
}

export interface AppliedWindowPlan {
  readonly dropped: readonly LedgerRef[];
  readonly failed: readonly LedgerRef[];
}

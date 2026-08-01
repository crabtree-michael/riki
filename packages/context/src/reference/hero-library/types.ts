/**
 * The shape of a hero note, and of a query for one.
 *
 * The library is reference data — the data that is not about this match. It holds nothing observed,
 * nothing timestamped and nothing per-player, which is why none of it is `Observed<T>`: there is no
 * age to render because there is nothing here that was seen.
 *
 * What it does carry is a **patch**, and that is the honest equivalent. See hero-library.md §5.
 */

import type { HeroId } from '../../common/types.js';

/**
 * The six things a coach is asked about a hero, and the whole of what the library holds.
 *
 * Closed, and small on purpose. It is the *only* axis anything narrows on — there is no free-text
 * alternative (ADR-0027) — so every value has to earn its place and none may be a synonym of
 * another.
 *
 * There is deliberately no `teamfight` value, which is the one a reader tends to reach for next:
 * nothing in the content answers it that `overview` and `counters` do not answer better, and an enum
 * value with no content behind it is a question the model is invited to ask and cannot be answered
 * (hero-library.md §8).
 */
export type HeroTopic = 'overview' | 'laning' | 'timings' | 'items' | 'weaknesses' | 'counters';

export const HERO_TOPICS: readonly HeroTopic[] = [
  'overview',
  'laning',
  'timings',
  'items',
  'weaknesses',
  'counters',
];

/** Position 1 through 5, the way a player says it. A hero may credibly hold more than one. */
export type Position = 1 | 2 | 3 | 4 | 5;

/**
 * One note. One sentence, speakable as written.
 *
 * Riki says these out loud, so the text is the final form — not a summary to be expanded and not a
 * paragraph to be compressed. A coaching brief is ~150 tokens for *everything*, so a note that
 * needed summarising before it could be spoken would never survive one (hero-library.md §3).
 */
export interface HeroNote {
  readonly topic: HeroTopic;
  readonly text: string;
  /** Higher survives truncation. The ladder is per hero, not global. */
  readonly priority: number;
}

export interface HeroEntry {
  /** Valve's `npc_dota_hero_*` suffix, which is also what the subject resolver produces. */
  readonly hero: HeroId;
  /** As a player says it, for the rendered result. */
  readonly name: string;
  readonly positions: readonly Position[];
  readonly notes: readonly HeroNote[];
}

/**
 * The library as a whole, stamped with what it was written against.
 *
 * `patch` is not decoration. Nothing refreshes this content (ADR-0023), so the patch is the only
 * thing that distinguishes "notes for 7.41e" from a claim about the game as it is now — and it is
 * rendered non-droppably for exactly that reason.
 */
export interface HeroLibrary {
  readonly patch: string;
  /** ISO date the roster and notes were authored. Telemetry and archaeology, not rendered. */
  readonly authored: string;
  readonly entries: readonly HeroEntry[];
}

/**
 * Two closed values and nothing else — no free text (ADR-0027). `topic` filters six one-line notes
 * more precisely than term overlap ever did, and an absent `topic` means "the hero's best notes"
 * rather than "no filter applied", which is the same thing here and reads better at the call site.
 */
export interface HeroLibraryQuery {
  readonly hero: HeroId;
  readonly topic?: HeroTopic;
}

export interface HeroLibraryResult {
  readonly hero: HeroId;
  readonly name: string;
  readonly patch: string;
  readonly positions: readonly Position[];
  /** In priority order, already capped. The `library` section applies the budget on top. */
  readonly notes: readonly HeroNote[];
}

/**
 * Tier 1 — the session preamble (dota2-state-capture-design.md §6.1).
 *
 * Assembled once at match start and then immutable, so it sits in the prompt cache prefix and costs
 * almost nothing per turn. That is the same property ADR-0011 gives the tool manifest, and for the
 * same reason: a change rewrites the prefix and busts the cache for the rest of the session.
 *
 * See docs/design/context-and-memory-architecture.md §4. Declarations only.
 */

import type { GameClock, HeroId, MatchId, MonoMs, Role } from '../common/types.js';
import type { RenderedText } from '../render/types.js';
import type { PlayerMemory } from '../memory/types.js';

// -----------------------------------------------------------------------------------------------
// Input (§4.1)
// -----------------------------------------------------------------------------------------------

export interface PreambleInput {
  readonly matchId: MatchId;
  readonly draft: DraftView;
  readonly player: PlayerIdentity;
  readonly patch: string;
  /** Durable, across matches (ADR-0013). May be empty; an empty memory is a working coach. */
  readonly memory: PlayerMemory;
}

/** The ten heroes, read from the world model at `match_started`. */
export interface DraftView {
  readonly allies: readonly HeroId[];
  readonly enemies: readonly HeroId[];
  readonly self: HeroId;
}

export interface PlayerIdentity {
  readonly hero: HeroId;
  readonly role: Role;
  readonly lane: 'safe' | 'mid' | 'off' | 'jungle' | 'roam' | 'unknown';
  /** Bracket, never a Steam ID or a name — dota2 §7 strips or hashes both before any egress. */
  readonly bracket: string | null;
}

// -----------------------------------------------------------------------------------------------
// Output (§4.1)
// -----------------------------------------------------------------------------------------------

export type PreambleSectionId =
  'persona' | 'player' | 'draft' | 'matchups' | 'patch_notes' | 'benchmarks' | 'history';

export interface PreambleSection extends RenderedText {
  readonly id: PreambleSectionId;
}

export interface Preamble extends RenderedText {
  readonly frozenAt: MonoMs;
  /** Per-section, so §4.2's budget is a sum of visible parts rather than one opaque number. */
  readonly sections: readonly PreambleSection[];
  /** Enrichment that did not arrive before the deadline. In telemetry; absent from the text. */
  readonly degraded: readonly PreambleSectionId[];
}

// -----------------------------------------------------------------------------------------------
// Enrichment (§4.3)
// -----------------------------------------------------------------------------------------------

/**
 * Best-effort and priority-ordered, so a deadline eats the tail rather than a random subset. The
 * player's own hero benchmark is worth more than the fifth enemy's matchup note.
 */
export type EnrichmentRequest =
  | { readonly want: 'matchup'; readonly a: HeroId; readonly b: HeroId }
  | { readonly want: 'benchmark'; readonly hero: HeroId; readonly at: GameClock }
  | { readonly want: 'patch_notes'; readonly hero: HeroId };

// -----------------------------------------------------------------------------------------------
// The prefix budget (§4.2)
// -----------------------------------------------------------------------------------------------

/**
 * Session instructions and tool definitions share a **16,384-token cap** and sit in the cached
 * prefix (realtime §1, §5; ADR-0011). Three growing things compete for it — the persona, this
 * preamble, and the manifest — and until this object existed, no single place added them up.
 *
 * The headroom is currently comfortable (~4,700 committed). The reason to have the object anyway is
 * that the preamble is the part that grows without anyone deciding to grow it: matchup notes, patch
 * notes and benchmarks are all "one more line per hero", and ten heroes times a few lines is how
 * 1,500 becomes 4,000 in a commit that does not look like it did anything.
 */
export interface PrefixBudget {
  readonly capTokens: number;
  readonly parts: ReadonlyMap<string, number>;
  total(): number;
  /** Checkable before a session exists, so it fails a test rather than a match. */
  check(): { readonly ok: boolean; readonly overBy: number };
}

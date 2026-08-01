/**
 * The rendering vocabulary — text with a token cost, sections with a priority, and a budget.
 *
 * Every tier produces text under a ceiling, and the ceiling is load-bearing: the prefix cap
 * (architecture §4.2) and the conversation window (§7.1) are both budgets, and a budget enforced
 * against a wrong number is not enforced. So a token count travels with every string in this
 * package rather than being recomputed by whoever needs it.
 *
 * See docs/design/context-and-memory-architecture.md §3.2 and §5.1.
 */

// -----------------------------------------------------------------------------------------------
// Token accounting (§3.2)
// -----------------------------------------------------------------------------------------------

/**
 * Injected, because an exact count needs a tokenizer and this package should not carry one.
 *
 * > **A counter that estimates must over-count.**
 *
 * The direction of the error is a design decision, not an implementation detail. An over-count
 * wastes headroom, costing a few tokens per turn. An under-count silently exceeds a cap, and is
 * discovered as an API error mid-match or as the API truncating something we believed was safe. A
 * Tier 1 test asserts `estimate(text) >= exact(text)` over the golden corpus, which is the only
 * place both numbers exist.
 */
export interface TokenCounter {
  count(text: string): number;
}

/** Text and its cost, together, so the cost is never recomputed from a string that has moved on. */
export interface RenderedText {
  readonly text: string;
  readonly tokens: number;
}

// -----------------------------------------------------------------------------------------------
// Sections and budgets (§5.2)
// -----------------------------------------------------------------------------------------------

/**
 * Identifies a line group in any tier's output: a snapshot line, a preamble block, a tool result
 * field. Kept open rather than a closed union so a tier can name its own without editing this file.
 */
export type SectionId = string & { readonly __brand: 'SectionId' };

/**
 * `droppable: false` is the structural form of dota2 §6.2's "self-state and enemy state never get
 * truncated". The composer cannot drop one, so a budget that cannot fit them fails loudly rather
 * than quietly producing a snapshot with no hero in it.
 */
export interface Section {
  readonly id: SectionId;
  /** Lower drops first. Assigned from the declared ladder, never from statement order (§5.2). */
  readonly priority: number;
  readonly body: RenderedText;
  readonly droppable: boolean;
}

export interface Budget {
  readonly maxTokens: number;
  /** What the caller has already spent, when a budget is shared across a turn (§7.1). */
  readonly spentTokens: number;
}

/** What the composer produced, and what it had to leave out. `omitted` is asserted by golden tests. */
export interface Composed extends RenderedText {
  readonly truncated: boolean;
  readonly omitted: readonly SectionId[];
}

// -----------------------------------------------------------------------------------------------
// Privacy classification (§5.1)
// -----------------------------------------------------------------------------------------------

/**
 * What kind of thing a field is, for the privacy gate. Chat text and player names are the two
 * classes dota2 §7 puts behind a default-off flag; everything else is game state.
 */
export type FieldClass = 'game_state' | 'chat_text' | 'player_name' | 'self_identity';

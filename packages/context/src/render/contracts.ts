/**
 * The three primitives every tier renders through.
 *
 * These exist because there are two renderers in this package — the Tier 2 snapshot and the
 * coaching brief — and the rules they must both obey are the same rules. Two implementations
 * written months apart would agree until the day one of them learned to say "probably", and doing
 * this afterwards means the two never re-converge. It is also why coaching-architecture.md §2.1
 * insists the brief's composer be written fresh against these rather than renamed out of the
 * deleted result renderer.
 *
 * See docs/design/context-and-memory-architecture.md §5.1. Declarations only.
 */

import type { GameClock, MonoMs, Observed, PrivacyPolicy } from '../common/types.js';
import type { Budget, Composed, FieldClass, Section } from './types.js';

/**
 * The one place a staleness becomes words: `4s ago(0.91)`, `~12s ago`, `unseen >20s`.
 *
 * dota2 §4 rule 3 and §6.2 both say a stale CV fact renders with its age and confidence or it does
 * not render at all. That rule is not enforced by anyone remembering it — it is enforced by there
 * being exactly one function that turns an `Observed<T>` into a string, and by handlers and section
 * sources having no bare value to render instead.
 *
 * Returns `null` for a fact below its confidence threshold: below-threshold facts are **dropped,
 * not hedged**, because hedging spends tokens to say nothing.
 */
export interface AgeFormatter {
  format(observed: Observed<unknown>, now: MonoMs, clock: GameClock | null): string | null;
}

/**
 * The second of the two independent gates on chat text; the first is at the source
 * (state-capture §4.2). `get_recent_events` and the snapshot's `recent:` line are the two places
 * other players' words could otherwise reach a third-party API.
 */
export interface PrivacyGate {
  allow(field: FieldClass, policy: PrivacyPolicy): boolean;
  /** For text that is allowed through but must lose names. Never a substitute for `allow`. */
  redact(text: string, policy: PrivacyPolicy): string;
}

/**
 * Assembles sections under a ceiling, dropping by priority and recording what went.
 *
 * Truncation is a design decision, not an accident, which is why `omitted` is part of the result
 * and part of the golden corpus: what survives a tight budget is reviewable as a diff.
 */
export interface SectionComposer {
  compose(sections: readonly Section[], budget: Budget): Composed;
}

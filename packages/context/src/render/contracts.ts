/**
 * The three primitives a rendering of a game fact goes through.
 *
 * They are separate from the renderer that uses them because two renderings written months apart
 * agree until the day one of them learns to say "probably", and doing this afterwards means the two
 * never re-converge.
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
 * (state-capture §4.2).
 *
 * It has no caller inside this package today — the snapshot's `recent:` line was the last one, and
 * ADR-0042 deleted the event tape behind it. It is kept, and kept exported, because the rule it
 * enforces (REPO_SKELETON.md §7.2) outlives any one renderer and the cost of re-deriving it later
 * is a privacy regression rather than an inconvenience.
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

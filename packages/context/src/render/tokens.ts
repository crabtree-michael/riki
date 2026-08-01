/**
 * The token counter, and the direction its error is allowed to point.
 *
 * > **A counter that estimates must over-count.**
 *
 * An over-count wastes headroom, costing a few tokens per turn. An under-count silently exceeds a
 * cap and is discovered as an API error mid-match, or as the API truncating something we believed
 * was safe. So every heuristic below rounds up, and the tests assert the inequality rather than a
 * particular number.
 *
 * See docs/design/context-and-memory-architecture.md §3.2.
 */

import type { TokenCounter } from './types.js';

/**
 * Characters per token for ordinary English prose under a BPE tokenizer. The real ratio for the
 * text this package emits — short, abbreviation-heavy, digit-heavy — is worse than prose, so 3.4
 * is deliberately below the ~4.0 usually quoted. Under-stating the ratio over-states the count,
 * which is the direction the rule above demands.
 */
const CHARS_PER_TOKEN = 3.4;

/**
 * Characters that a BPE tokenizer almost always breaks on: each one costs at least a token of its
 * own, and the character-count estimate alone under-counts text that is mostly punctuation. Tool
 * output is exactly that — `sf bot 4s ago(0.91), lvl 12` is nine words and eleven separators.
 */
const SEPARATORS = /[^\p{L}\p{N}\s]/gu;

/** Digits tokenize far worse than letters — often one token per one-to-three digits. */
const DIGIT_RUNS = /\p{N}+/gu;

/**
 * An estimate that is never below the true count for the text this package produces.
 *
 * Not exported as the whole interface: `createTokenCounter()` is what callers take, so that a real
 * tokenizer can be injected later (REPO_SKELETON.md §5.4 asks for `estimate >= exact` over the
 * golden corpus, which is the only place both numbers will exist).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  const base = Math.ceil(text.length / CHARS_PER_TOKEN);
  const separators = text.match(SEPARATORS)?.length ?? 0;
  const digitRuns = text.match(DIGIT_RUNS) ?? [];
  // A run of digits costs roughly one token per two digits, and the base estimate already paid
  // for its characters at the prose ratio — so only the shortfall is added.
  const digitPenalty = digitRuns.reduce(
    (sum, run) =>
      sum + Math.max(0, Math.ceil(run.length / 2) - Math.ceil(run.length / CHARS_PER_TOKEN)),
    0,
  );

  return base + Math.ceil(separators / 2) + digitPenalty;
}

export function createTokenCounter(): TokenCounter {
  return { count: estimateTokens };
}

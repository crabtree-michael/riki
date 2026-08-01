/**
 * The prefix budget nobody was tracking — §4.2.
 *
 * Session instructions and tool definitions share a **16,384-token cap** and sit in the cached
 * prefix (realtime §1, ADR-0011). Three growing things compete for it — the persona, the preamble,
 * and the tool manifest — and until this object existed, two documents had sized their half of that
 * cap independently and no test summed them.
 *
 * The headroom is comfortable today (~4,700 committed of 16,384), and saying so is more useful than
 * implying a tightness that does not exist. The reason to have the object anyway is that **the
 * preamble is the part that grows without anyone deciding to grow it**: matchup notes, patch notes
 * and build benchmarks are all "one more line per hero", and ten heroes times a few lines is how
 * 1,500 becomes 4,000 in a commit that does not look like it did anything.
 *
 * `check()` fails a test, not a match: all three numbers are knowable before a session exists.
 */

import type { PrefixBudget } from './types.js';

/** realtime §1. Instructions and tool definitions share it. */
export const PREFIX_CAP_TOKENS = 16_384;

/** §4.2's table, as the starting allocation. Every number is *(tunable)*. */
export const PREFIX_ALLOCATION = {
  persona: 1_200,
  preamble: 1_500,
  manifest: 2_000,
} as const;

export function createPrefixBudget(
  parts: ReadonlyMap<string, number>,
  capTokens: number = PREFIX_CAP_TOKENS,
): PrefixBudget {
  return {
    capTokens,
    parts,

    total(): number {
      let sum = 0;
      for (const tokens of parts.values()) sum += tokens;
      return sum;
    },

    check(): { readonly ok: boolean; readonly overBy: number } {
      let sum = 0;
      for (const tokens of parts.values()) sum += tokens;
      return { ok: sum <= capTokens, overBy: Math.max(0, sum - capTokens) };
    },
  };
}

/**
 * The prefix budget nobody was tracking — §4.2.
 *
 * Session instructions sit in the cached prefix under a **16,384-token cap** (realtime §1). Two
 * growing things compete for it — the persona and the preamble — and until this object existed,
 * two documents had sized their half of that cap independently and no test summed them.
 *
 * There were three, and the third was 2,000 tokens of tool manifest. ADR-0023 deleted it
 * (coaching-architecture.md §8.1), so the headroom went from comfortable to very comfortable
 * (~3,000 committed of 16,384) — and saying so is more useful than implying a tightness that does
 * not exist. The reason to keep the object anyway is that **the preamble is the part that grows
 * without anyone deciding to grow it**: matchup notes, patch notes and build benchmarks are all
 * "one more line per hero", they are now the *only* place reference data can be fetched at all
 * (§5.3), and ten heroes times a few lines is how 1,500 becomes 4,000 in a commit that does not
 * look like it did anything.
 *
 * `check()` fails a test, not a match: every number is knowable before a session exists.
 */

import type { PrefixBudget } from './types.js';

/** realtime §1. The session's instructions, entire. */
export const PREFIX_CAP_TOKENS = 16_384;

/**
 * coaching-architecture.md §8.1's table, as the starting allocation. Every number is *(tunable)*.
 *
 * The preamble's 1,800 is 300 more than context-and-memory §4.2 gave it, because reference data
 * that three commands used to fetch mid-match now lives here or nowhere (§5.3).
 */
export const PREFIX_ALLOCATION = {
  persona: 1_200,
  preamble: 1_800,
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

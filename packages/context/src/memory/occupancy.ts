/**
 * What one ledger entry costs in the model's context window.
 *
 * This is the number every part of §7 is sized against, and it has one trap in it worth stating
 * plainly, because getting it wrong makes the retention policy confidently wrong rather than
 * noisily wrong.
 *
 * > **An utterance occupies the window as audio, not as its transcript.**
 *
 * realtime §5 prices assistant audio at ~1,200 tokens/minute and user audio at ~600. A transcript
 * of the same speech counts a fraction of that, so a ledger that costed `agent_said` by its text
 * would believe the window was far emptier than it is — and would discover the truth as the API
 * truncating oldest-first, which takes the cached prefix (§7.3). So speech is costed from a spoken
 * word-rate, and the text count is a floor rather than the answer.
 *
 * Every constant below is an **estimate**, and they are the estimates §12's first row asks to be
 * measured against real usage reporting before anything is built on them. They err upward on
 * purpose: §3.2's rule is that a counter which estimates must over-count, and the same reasoning
 * applies one level up — over-counting compacts a little early, under-counting compacts too late,
 * and only one of those is recoverable.
 */

import type { TokenCounter } from '../render/types.js';
import type { LedgerEntry } from './types.js';

/**
 * ~1,200 tokens/min of assistant audio (realtime §5) at ~150 spoken words/min is 8 tokens a word.
 * User audio is priced at half that by the same source, but this is not split by speaker: an
 * over-count on the player's side is a few tokens a turn, and a per-speaker constant is a second
 * thing to keep calibrated for no decision it would change.
 */
export const TOKENS_PER_SPOKEN_WORD = 8;

function words(text: string): number {
  const matched = text.trim().match(/\S+/gu);
  return matched === null ? 0 : matched.length;
}

/** Speech, costed as audio. The text count is a floor — never the answer, and never below it. */
export function speechTokens(transcript: string, counter: TokenCounter): number {
  return Math.max(counter.count(transcript), words(transcript) * TOKENS_PER_SPOKEN_WORD);
}

/**
 * Zero for entries the model never sees.
 *
 * `turn_opened` and `turn_closed` are Riki's own bookkeeping; counting them as occupancy would put
 * drift into our window estimate that has nothing to do with the API — the §7.6 signal, faked by us.
 */
export function entryTokens(entry: LedgerEntry, counter: TokenCounter): number {
  switch (entry.kind) {
    case 'snapshot':
      return entry.rendered.tokens;
    case 'summary':
      return entry.rendered.tokens;
    case 'brief':
      return entry.rendered.tokens;
    case 'agent_said':
    case 'player_said':
      return speechTokens(entry.transcript, counter);
    case 'turn_opened':
    case 'turn_closed':
      return 0;
  }
}

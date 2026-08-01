/**
 * `history: raised 2× on this, last at 12:40, ignored — do not repeat it`
 *
 * **The section with no equivalent in the deleted design, and the one that makes proactive coaching
 * not feel like an alarm clock** (coaching-architecture.md §5.4).
 *
 * It renders *only on a repeat*. A first mention has no history, so the line is absent and the
 * brief is that much smaller; a second mention says so, and says how the first went, so the model
 * can say "still worth getting that BKB" rather than the same sentence again. Under P2 that matters
 * more than it looks: a proactive coach that cannot tell whether it is being useful is a proactive
 * coach that will keep saying the same thing.
 *
 * Nothing here goes through `AgeFormatter`, and that is correct rather than an omission: this is
 * the conversation ledger, not the world model. What Riki said and when it said it are exact by
 * construction (ADR-0012) — there is no observation behind them to be stale about.
 *
 * `response` comes from `CoachingMemory.observeOutcome`, which watches the **world model** — the
 * item appeared, or the gold went elsewhere. context-and-memory §6.3: *"The player saying 'yeah
 * okay' is worth nothing; the item is worth everything."*
 */

import type { AdviceResponse } from '../../memory/types.js';
import type { BriefSectionSource } from '../contracts.js';
import { clockText, join, line } from './util.js';

/** How far back a repeat still counts as one *(tunable: 10 minutes)*. */
export const HISTORY_WINDOW_SECONDS = 600;

/**
 * What to tell the model to do about it. The `followed` case is the interesting one: the advice
 * landed, so raising it again is not a repeat but a *new* situation, and saying "you did this"
 * stops the model narrating it as though it were the first time.
 */
const GUIDANCE: Readonly<Record<AdviceResponse, string>> = {
  unknown: 'do not repeat it verbatim',
  followed: 'they acted on it — do not repeat it',
  ignored: 'they did not act on it — say it differently or not at all',
  dismissed: 'they told you to drop it — do not raise it again',
};

export const history: BriefSectionSource = {
  id: 'history',

  build(_world, ctx) {
    if (ctx.topic === undefined || ctx.history === null) return null;

    const record = ctx.history.recent(ctx.topic, HISTORY_WINDOW_SECONDS);
    if (record === undefined) return null;

    return line(
      'history',
      'history',
      join(
        [
          `raised ${String(record.count)}× on this`,
          `last at ${clockText(record.lastAt)}`,
          GUIDANCE[record.response],
        ],
        ', ',
      ),
    );
  },
};

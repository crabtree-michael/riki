/**
 * Keeping a 45-minute match inside a 32k window.
 *
 * openai-realtime-research.md §5 calls this "the real constraint", and the arithmetic is stark:
 * assistant audio burns 1,200 tokens per minute and user audio 600, so a naive session hits the
 * ceiling in **15–20 minutes**. A Dota match is 35–45. The 60-minute session cap is not the
 * binding limit; this is.
 *
 * What makes it a *policy* rather than a setting is the cache. §10: cached audio input is
 * $0.40/M against $32/M — an **80× discount** — so cache behaviour dominates the bill outright.
 * And every truncation busts the cache, because changing the head of the conversation invalidates
 * everything after it. That inverts the intuitive strategy:
 *
 *   > Trimming aggressively but rarely is much cheaper than trimming minimally but constantly.
 *
 * Hence `retentionRatio` defaulting to 0.8 rather than to something that just barely fits. The
 * guarding test (REPO_SKELETON.md §5.4) simulates 25 minutes and asserts both that the policy
 * fires and that the number of cache-busting compactions stays under a threshold.
 *
 * ⚠ The token *estimates* here are from §5 and §10 and have not been measured against a live
 * session — REPO_SKELETON.md §11 open question 11 asks whether Riki's own context injection
 * dominates the window. `observe()` takes real usage from `response.done` whenever the API
 * reports it, so the estimate is only ever a fallback.
 */

import {
  ASSISTANT_AUDIO_TOKENS_PER_MS,
  INPUT_CEILING_TOKENS,
  USER_AUDIO_TOKENS_PER_MS,
  type Millis,
  type Tokens,
} from '../types.js';

export interface TurnAccounting {
  readonly itemId: string;
  readonly userAudioMs: Millis;
  readonly assistantAudioMs: Millis;
  /** Snapshot, preamble and tool output injected for this turn (dota2 §6.2). */
  readonly injectedTokens: Tokens;
  /** Real numbers from `response.done`, when the API reported them. Preferred over the estimate. */
  readonly reportedInputTokens?: Tokens;
}

export type RetentionDecision =
  | { readonly kind: 'keep'; readonly estimatedTokens: Tokens }
  | {
      readonly kind: 'compact';
      readonly estimatedTokens: Tokens;
      /** Everything up to and including this item is replaced by a summary. */
      readonly dropThroughItemId: string;
      readonly targetTokens: Tokens;
      readonly droppedTurns: number;
    };

export interface RetentionPolicyOptions {
  /**
   * Fraction of the input ceiling to compact down *to*. Leave real headroom, so the next
   * compaction is far away — see the note below on why this is not §5's 0.8.
   */
  readonly retentionRatio?: number;
  /** Fraction of the ceiling at which compaction triggers. */
  readonly highWaterRatio?: number;
  /** Never compact away the last few turns, however large — the model needs recent context. */
  readonly minRetainedTurns?: number;
  readonly ceilingTokens?: Tokens;
}

/**
 * **These are deliberately not §5's `retention_ratio: 0.8`, and the difference is easy to get
 * wrong.** That number is the *API's* parameter, and the API's trigger is the window being
 * genuinely full — so 0.8 there means "cut to 80 % of 100 %", leaving 20 % of headroom. Our
 * trigger is 90 %, so copying 0.8 would leave 10 % and compact twice as often as OpenAI's own
 * advice implies.
 *
 * The arithmetic that fixes the numbers, for a busy match — one turn per 20 s carrying ~500
 * tokens (12 s of speech plus ~300 tokens of injected snapshot, dota2 §6.2):
 *
 * | retain → | headroom | turns between compactions | compactions per 45-min match |
 * |----------|----------|---------------------------|------------------------------|
 * | 0.8      | 10 %     | ~6                        | ~10                          |
 * | **0.6**  | **30 %** | **~17**                   | **~5**                       |
 * | 0.5      | 40 %     | ~23                       | ~4                           |
 *
 * At $32/M uncached against $0.40/M cached, each compaction re-pays full price for everything
 * retained. 0.8 costs roughly four times what 0.6 does over a match. 0.5 is marginally cheaper
 * still and throws away more of the conversation, which is a quality cost rather than a
 * measurable one — so 0.6 is the compromise, and it is a *(tunable)* number, not a derived one.
 */
const DEFAULTS = {
  retentionRatio: 0.6,
  highWaterRatio: 0.9,
  minRetainedTurns: 4,
} as const;

interface Turn {
  readonly itemId: string;
  readonly tokens: Tokens;
}

export class RetentionPolicy {
  readonly #retentionRatio: number;
  readonly #highWaterRatio: number;
  readonly #minRetainedTurns: number;
  readonly #ceiling: Tokens;

  readonly #turns: Turn[] = [];
  #compactions = 0;
  /** Tokens carried by summaries that replaced dropped turns. They are not free. */
  #summaryTokens: Tokens = 0;

  constructor(options: RetentionPolicyOptions = {}) {
    this.#retentionRatio = options.retentionRatio ?? DEFAULTS.retentionRatio;
    this.#highWaterRatio = options.highWaterRatio ?? DEFAULTS.highWaterRatio;
    this.#minRetainedTurns = options.minRetainedTurns ?? DEFAULTS.minRetainedTurns;
    this.#ceiling = options.ceilingTokens ?? INPUT_CEILING_TOKENS;
  }

  /** Every compaction is one cache bust. This is the number the §5.4 test asserts on. */
  get compactions(): number {
    return this.#compactions;
  }

  get estimatedTokens(): Tokens {
    return this.#turns.reduce((sum, turn) => sum + turn.tokens, this.#summaryTokens);
  }

  get retainedTurns(): number {
    return this.#turns.length;
  }

  observe(turn: TurnAccounting): RetentionDecision {
    this.#turns.push({ itemId: turn.itemId, tokens: estimateTurnTokens(turn) });

    const total = this.estimatedTokens;
    if (total < this.#ceiling * this.#highWaterRatio) {
      return { kind: 'keep', estimatedTokens: total };
    }

    const target = this.#ceiling * this.#retentionRatio;
    const droppable = Math.max(0, this.#turns.length - this.#minRetainedTurns);

    let dropped = 0;
    let remaining = total;
    let dropThroughItemId: string | null = null;

    while (dropped < droppable && remaining > target) {
      const turnToDrop = this.#turns[dropped];
      if (!turnToDrop) break;
      remaining -= turnToDrop.tokens;
      dropThroughItemId = turnToDrop.itemId;
      dropped += 1;
    }

    // Nothing droppable: the retained tail alone exceeds the target. Compacting would either be a
    // no-op or would delete the context the model is mid-conversation about, so we ride it out
    // and let the API's own truncation handle the overflow.
    if (dropThroughItemId === null || dropped === 0) {
      return { kind: 'keep', estimatedTokens: total };
    }

    this.#turns.splice(0, dropped);
    this.#summaryTokens += SUMMARY_TOKEN_COST;
    this.#compactions += 1;

    return {
      kind: 'compact',
      estimatedTokens: this.estimatedTokens,
      dropThroughItemId,
      targetTokens: target,
      droppedTurns: dropped,
    };
  }

  reset(): void {
    this.#turns.length = 0;
    this.#summaryTokens = 0;
    this.#compactions = 0;
  }
}

/** A compacted span is replaced by a summary item; this is its assumed size. *(tunable)* */
export const SUMMARY_TOKEN_COST: Tokens = 150;

export function estimateTurnTokens(turn: TurnAccounting): Tokens {
  const audio =
    turn.userAudioMs * USER_AUDIO_TOKENS_PER_MS +
    turn.assistantAudioMs * ASSISTANT_AUDIO_TOKENS_PER_MS;
  // Reported input tokens already include the audio the API counted, so they replace the
  // estimate rather than adding to it.
  return (turn.reportedInputTokens ?? audio) + turn.injectedTokens;
}

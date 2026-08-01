/**
 * Cost accounting, kept in this package on purpose.
 *
 * The `voice-realtime` skill is explicit about why: *"The model choice is the main cost lever,
 * and the mini model is the default for a reason. Cost accounting lives in this package — keep
 * it, it is how the lever stays visible."* A number nobody can see is a number nobody manages,
 * and openai-realtime-research.md §11.1 names the structural hazard — **cost scales with
 * engagement**, so the more a player likes Riki the more it costs, with no ceiling except one we
 * build.
 *
 * Prices are per million tokens, from §1 and §10.
 */

import type { RealtimeModel, Tokens } from '../types.js';
import type { UsageReport } from '../protocol/server-events.js';

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly cachedInputPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * §10: cached audio input is $0.40/M against $32/M — an 80× discount, which is why
 * `retention/policy.ts` cares so much about not busting the cache.
 *
 * ⚠ The mini cached rate is **derived, not published**: §10 states the 80× discount for the
 * flagship only. $10/M ÷ 80 = $0.125/M is the assumption, and it flatters mini if the real
 * discount is smaller. It affects the reported bill, never the behaviour.
 */
export const PRICING: Record<RealtimeModel, ModelPricing> = {
  'gpt-realtime-2.1': { inputPerMTok: 32, cachedInputPerMTok: 0.4, outputPerMTok: 64 },
  'gpt-realtime-2.1-mini': { inputPerMTok: 10, cachedInputPerMTok: 0.125, outputPerMTok: 20 },
  'gpt-realtime': { inputPerMTok: 32, cachedInputPerMTok: 0.4, outputPerMTok: 64 },
};

export interface CostSnapshot {
  readonly inputTokens: Tokens;
  readonly cachedInputTokens: Tokens;
  readonly outputTokens: Tokens;
  readonly usd: number;
  /** How much of the input was served from cache. The single most useful number here. */
  readonly cacheHitRatio: number;
  readonly turns: number;
}

export class CostMeter {
  readonly #pricing: ModelPricing;
  #inputTokens: Tokens = 0;
  #cachedInputTokens: Tokens = 0;
  #outputTokens: Tokens = 0;
  #turns = 0;

  constructor(model: RealtimeModel) {
    this.#pricing = PRICING[model];
  }

  record(usage: UsageReport): void {
    this.#turns += 1;
    // `input_tokens` is the total; cached tokens are a subset of it, billed at the lower rate.
    this.#cachedInputTokens += usage.cachedInputTokens;
    this.#inputTokens += Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    this.#outputTokens += usage.outputTokens;
  }

  snapshot(): CostSnapshot {
    const totalInput = this.#inputTokens + this.#cachedInputTokens;
    const usd =
      (this.#inputTokens * this.#pricing.inputPerMTok +
        this.#cachedInputTokens * this.#pricing.cachedInputPerMTok +
        this.#outputTokens * this.#pricing.outputPerMTok) /
      1_000_000;

    return {
      inputTokens: this.#inputTokens,
      cachedInputTokens: this.#cachedInputTokens,
      outputTokens: this.#outputTokens,
      usd,
      cacheHitRatio: totalInput === 0 ? 0 : this.#cachedInputTokens / totalInput,
      turns: this.#turns,
    };
  }

  reset(): void {
    this.#inputTokens = 0;
    this.#cachedInputTokens = 0;
    this.#outputTokens = 0;
    this.#turns = 0;
  }
}

/**
 * §11.1: "Per-user budgets are not optional." This is the mechanism, not the policy — what the
 * cap should be, and what happens when it is hit, is a product decision that has not been taken.
 */
export interface BudgetGuard {
  readonly limitUsd: number;
  exceeded(snapshot: CostSnapshot): boolean;
}

export function createBudgetGuard(limitUsd: number): BudgetGuard {
  return {
    limitUsd,
    exceeded: (snapshot) => snapshot.usd >= limitUsd,
  };
}

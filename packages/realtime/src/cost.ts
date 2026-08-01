/**
 * Cost accounting, which lives in this package so the lever stays visible (realtime §10).
 *
 * The arithmetic that matters, from architecture §5.8's worked example — a 40-minute match, 20
 * turns, mini rates: input audio ~$0.02, output audio ~$0.06, and context replay somewhere between
 * $0.10 and $0.80 depending entirely on how much of it was cached. Cached audio input is an 80×
 * discount, so **the cached fraction is the only number in the bill that matters**, and anything
 * that busts the cache — frequent small truncations, a rotating preamble, a manifest that changes
 * mid-session — costs multiples rather than percentages.
 *
 * realtime §11.1 is the reason `onBudgetExceeded` exists at all: cost scales with engagement, and
 * there is no ceiling except one we build. When it fires, Riki says so once and stops opening
 * turns — a coach that silently stops working is worse than one that says it ran out.
 *
 * See docs/design/voice-input-architecture.md §5.8.
 */

import type { TokenUsage, Unsubscribe } from './types.js';

/** Dollars per million tokens. From the model table in realtime §1, injected rather than hardcoded. */
export interface ModelRates {
  readonly inputAudioPerM: number;
  readonly cachedInputPerM: number;
  readonly outputAudioPerM: number;
  readonly textPerM: number;
}

export interface CostSnapshot {
  readonly inputAudioTokens: number;
  readonly cachedInputTokens: number;
  readonly outputAudioTokens: number;
  readonly textTokens: number;
  readonly usd: number;
  readonly turns: number;
  /** 0..1. The number to look at first when a match costs more than it should. */
  readonly cachedFraction: number;
}

export interface CostMeter {
  /** Only ever real reported usage. An estimated turn is worse than a missing one here. */
  record(usage: TokenUsage): void;
  snapshot(): CostSnapshot;
  /** Fires once per session, at `budgetUsd` (default 1.00 per match). */
  onBudgetExceeded(listener: (snapshot: CostSnapshot) => void): Unsubscribe;
}

/** realtime §1, mini tier. Injected rather than read here, so a price change is one call site. */
export const MINI_RATES: ModelRates = {
  inputAudioPerM: 10,
  cachedInputPerM: 0.125,
  outputAudioPerM: 20,
  textPerM: 0.6,
};

/**
 * ⚠ `cachedInputPerM` for mini is **derived, not published**. realtime §10 gives the 80× cached
 * discount for the flagship only ($32 → $0.40); $10 ÷ 80 = $0.125 is the assumption. It flatters
 * mini if the real discount is smaller, and it affects the reported bill rather than any
 * behaviour — but the cached fraction is the number this whole file exists to surface, so the
 * assumption should be replaced with a measurement the first time a real session is billed.
 */
export const FLAGSHIP_RATES: ModelRates = {
  inputAudioPerM: 32,
  cachedInputPerM: 0.4,
  outputAudioPerM: 64,
  textPerM: 1.6,
};

/** realtime §11.1: cost scales with engagement, and there is no ceiling except one we build. */
export const DEFAULT_BUDGET_USD = 1.0;

export function createCostMeter(rates: ModelRates, budgetUsd: number): CostMeter {
  let inputAudioTokens = 0;
  let cachedInputTokens = 0;
  let outputAudioTokens = 0;
  let textTokens = 0;
  let turns = 0;
  let fired = false;
  const listeners = new Set<(snapshot: CostSnapshot) => void>();

  const snapshot = (): CostSnapshot => {
    // Cached tokens are a subset of the input the API reports, billed at the lower rate — so the
    // uncached remainder is what the full rate applies to. Charging both would roughly double the
    // reported bill on a well-cached match, which is exactly when the number is most looked at.
    const uncachedInput = Math.max(0, inputAudioTokens - cachedInputTokens);
    const usd =
      (uncachedInput * rates.inputAudioPerM +
        cachedInputTokens * rates.cachedInputPerM +
        outputAudioTokens * rates.outputAudioPerM +
        textTokens * rates.textPerM) /
      1_000_000;

    return {
      inputAudioTokens,
      cachedInputTokens,
      outputAudioTokens,
      textTokens,
      usd,
      turns,
      cachedFraction: inputAudioTokens === 0 ? 0 : cachedInputTokens / inputAudioTokens,
    };
  };

  return {
    record(usage) {
      turns += 1;
      inputAudioTokens += usage.inputAudioTokens;
      cachedInputTokens += usage.cachedInputTokens;
      outputAudioTokens += usage.outputAudioTokens;
      textTokens += usage.textTokens;

      // Once per session: a coach that repeats "you have run out" every turn is worse than one
      // that says it once and stops.
      if (fired) return;
      const current = snapshot();
      if (current.usd < budgetUsd) return;
      fired = true;
      for (const listener of listeners) listener(current);
    },

    snapshot,

    onBudgetExceeded(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

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
 * See docs/design/voice-input-architecture.md §5.8. Declarations only.
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

export declare function createCostMeter(rates: ModelRates, budgetUsd: number): CostMeter;

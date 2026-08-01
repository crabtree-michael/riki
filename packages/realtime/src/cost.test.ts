import { describe, expect, it, vi } from 'vitest';
import { createCostMeter, DEFAULT_BUDGET_USD, FLAGSHIP_RATES, MINI_RATES } from './cost.js';
import type { MonoMs, TokenUsage } from './types.js';

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputAudioTokens: 1000,
    cachedInputTokens: 0,
    outputAudioTokens: 500,
    textTokens: 0,
    at: 0 as MonoMs,
    ...over,
  };
}

describe('the arithmetic', () => {
  it('bills the uncached remainder at full rate and the cached part at the discount', () => {
    // Cached tokens are a *subset* of the reported input. Charging both would roughly double the
    // reported bill on a well-cached match — exactly when the number is most looked at.
    const meter = createCostMeter(MINI_RATES, DEFAULT_BUDGET_USD);
    meter.record(
      usage({ inputAudioTokens: 2000, cachedInputTokens: 1500, outputAudioTokens: 500 }),
    );

    const expected =
      (500 * MINI_RATES.inputAudioPerM +
        1500 * MINI_RATES.cachedInputPerM +
        500 * MINI_RATES.outputAudioPerM) /
      1e6;
    expect(meter.snapshot().usd).toBeCloseTo(expected, 10);
  });

  it('reports the cached fraction, the number to look at first', () => {
    const meter = createCostMeter(MINI_RATES, DEFAULT_BUDGET_USD);
    meter.record(usage({ inputAudioTokens: 2000, cachedInputTokens: 1500 }));
    expect(meter.snapshot().cachedFraction).toBeCloseTo(0.75, 10);
  });

  it('is zero, not NaN, before anything has been recorded', () => {
    const snapshot = createCostMeter(MINI_RATES, DEFAULT_BUDGET_USD).snapshot();
    expect(snapshot.usd).toBe(0);
    expect(snapshot.cachedFraction).toBe(0);
    expect(snapshot.turns).toBe(0);
  });

  it('accumulates across turns', () => {
    const meter = createCostMeter(MINI_RATES, DEFAULT_BUDGET_USD);
    meter.record(usage());
    meter.record(usage());
    expect(meter.snapshot().turns).toBe(2);
    expect(meter.snapshot().inputAudioTokens).toBe(2000);
  });

  it('shows mini as roughly a third of the flagship — the cost lever, made visible', () => {
    const mini = createCostMeter(MINI_RATES, 1000);
    const flagship = createCostMeter(FLAGSHIP_RATES, 1000);
    mini.record(usage());
    flagship.record(usage());
    expect(flagship.snapshot().usd / mini.snapshot().usd).toBeCloseTo(3.2, 1);
  });

  it('makes the cache discount visible — an 80× swing on the same tokens', () => {
    const uncached = createCostMeter(FLAGSHIP_RATES, 1000);
    const cached = createCostMeter(FLAGSHIP_RATES, 1000);
    uncached.record(
      usage({ inputAudioTokens: 10_000, cachedInputTokens: 0, outputAudioTokens: 0 }),
    );
    cached.record(
      usage({ inputAudioTokens: 10_000, cachedInputTokens: 10_000, outputAudioTokens: 0 }),
    );
    expect(uncached.snapshot().usd / cached.snapshot().usd).toBeCloseTo(80, 0);
  });
});

describe('the budget guard', () => {
  it('fires once at the limit and never again', () => {
    // realtime §11.1: cost scales with engagement and there is no ceiling except one we build.
    // A coach that repeats "you have run out" every turn is worse than one that says it once.
    const meter = createCostMeter(MINI_RATES, 0.01);
    const listener = vi.fn();
    meter.onBudgetExceeded(listener);

    for (let i = 0; i < 10; i += 1) {
      meter.record(usage({ inputAudioTokens: 100_000, outputAudioTokens: 100_000 }));
    }
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire below the limit', () => {
    const meter = createCostMeter(MINI_RATES, 100);
    const listener = vi.fn();
    meter.onBudgetExceeded(listener);
    meter.record(usage());
    expect(listener).not.toHaveBeenCalled();
  });

  it('hands the listener the snapshot that crossed the line', () => {
    const meter = createCostMeter(MINI_RATES, 0.01);
    let seen = 0;
    meter.onBudgetExceeded((snapshot) => (seen = snapshot.usd));
    meter.record(usage({ inputAudioTokens: 500_000, outputAudioTokens: 500_000 }));
    expect(seen).toBeGreaterThanOrEqual(0.01);
  });

  it('stops notifying an unsubscribed listener', () => {
    const meter = createCostMeter(MINI_RATES, 0.01);
    const listener = vi.fn();
    meter.onBudgetExceeded(listener)();
    meter.record(usage({ inputAudioTokens: 500_000, outputAudioTokens: 500_000 }));
    expect(listener).not.toHaveBeenCalled();
  });
});

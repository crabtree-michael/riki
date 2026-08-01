/**
 * The guarding test REPO_SKELETON.md §5.4 names:
 *
 * > Simulate a 25-minute session; assert the retention policy fires and cache-busting
 * > truncations stay under a threshold.
 *
 * Both halves matter and they pull against each other. A policy that never fires overflows the
 * 32k window and lets the API drop turns oldest-first (research §5). A policy that fires
 * constantly keeps the window comfortable and destroys the 80× prompt-cache discount (§10),
 * which is the difference between $0.05/min and $0.46/min.
 */

import { describe, expect, it } from 'vitest';
import { RetentionPolicy, estimateTurnTokens } from './policy.js';
import { INPUT_CEILING_TOKENS } from '../types.js';

/** A turn of roughly the shape dota2 §6.2 describes: ~300 tokens of snapshot plus the audio. */
function turn(index: number, userMs = 4000, assistantMs = 8000) {
  return {
    itemId: `item_${String(index)}`,
    userAudioMs: userMs,
    assistantAudioMs: assistantMs,
    injectedTokens: 300,
  };
}

describe('token estimation', () => {
  it('follows §10 — 1 token per 100 ms of user audio, 1 per 50 ms of assistant', () => {
    expect(estimateTurnTokens(turn(0, 6000, 6000))).toBe(60 + 120 + 300);
  });

  it('prefers reported usage over the estimate when the API gave us real numbers', () => {
    expect(estimateTurnTokens({ ...turn(0), reportedInputTokens: 5000 })).toBe(5300);
  });
});

describe('a 25-minute session', () => {
  /**
   * §5's arithmetic: assistant audio burns 1,200 tokens/min and user audio 600, so a naive
   * session hits the ceiling in 15–20 minutes. 25 minutes of conversation is comfortably past it,
   * which is exactly why the test picks that number.
   */
  function runMinutes(minutes: number, policy: RetentionPolicy) {
    // One turn every 20 s: 12 s of speech and 8 s of thinking, which is a busy match.
    const turns = Math.floor((minutes * 60) / 20);
    const decisions = [];
    for (let i = 0; i < turns; i += 1) decisions.push(policy.observe(turn(i)));
    return decisions;
  }

  it('fires — the window really does fill', () => {
    const policy = new RetentionPolicy();
    const decisions = runMinutes(25, policy);
    expect(decisions.some((decision) => decision.kind === 'compact')).toBe(true);
    expect(policy.compactions).toBeGreaterThan(0);
  });

  it('keeps the session inside the input ceiling throughout', () => {
    const policy = new RetentionPolicy();
    for (const decision of runMinutes(25, policy)) {
      expect(decision.estimatedTokens).toBeLessThan(INPUT_CEILING_TOKENS);
    }
  });

  it('busts the cache rarely — trim aggressively but seldom, per §5', () => {
    const policy = new RetentionPolicy();
    runMinutes(25, policy);
    // Every compaction invalidates the prompt cache from the head onward. A handful over 25
    // minutes is the design; one every couple of turns would mean paying $32/M instead of $0.40.
    expect(policy.compactions).toBeLessThanOrEqual(3);
  });

  it('survives a full 45-minute match without unbounded growth', () => {
    const policy = new RetentionPolicy();
    runMinutes(45, policy);
    expect(policy.estimatedTokens).toBeLessThan(INPUT_CEILING_TOKENS);
    expect(policy.compactions).toBeLessThanOrEqual(6);
  });
});

describe('compaction behaviour', () => {
  it('compacts down to the retention ratio, not to just-barely-fitting', () => {
    const policy = new RetentionPolicy({ retentionRatio: 0.8 });
    let compacted = null;
    for (let i = 0; i < 200 && compacted === null; i += 1) {
      const decision = policy.observe(turn(i));
      if (decision.kind === 'compact') compacted = decision;
    }
    expect(compacted).not.toBeNull();
    expect(compacted?.estimatedTokens).toBeLessThanOrEqual(INPUT_CEILING_TOKENS * 0.85);
  });

  it('names the item to drop through, so the transcript and the wire stay in step', () => {
    const policy = new RetentionPolicy();
    let compacted = null;
    for (let i = 0; i < 200 && compacted === null; i += 1) {
      const decision = policy.observe(turn(i));
      if (decision.kind === 'compact') compacted = decision;
    }
    expect(compacted?.dropThroughItemId).toMatch(/^item_\d+$/);
    expect(compacted?.droppedTurns).toBeGreaterThan(0);
  });

  it('never drops the recent turns the model is mid-conversation about', () => {
    const policy = new RetentionPolicy({ minRetainedTurns: 4 });
    for (let i = 0; i < 200; i += 1) policy.observe(turn(i));
    expect(policy.retainedTurns).toBeGreaterThanOrEqual(4);
  });

  it('rides out a single turn too large to compact rather than deleting live context', () => {
    const policy = new RetentionPolicy({ minRetainedTurns: 4 });
    // Four enormous turns: the retained tail alone exceeds the target, so there is nothing
    // droppable. Compacting anyway would delete what the model is currently talking about.
    const huge = { ...turn(0), injectedTokens: 10_000 };
    for (let i = 0; i < 4; i += 1) policy.observe({ ...huge, itemId: `item_${String(i)}` });
    expect(policy.observe({ ...huge, itemId: 'item_4' }).kind).toBe('compact');
    expect(policy.retainedTurns).toBeGreaterThanOrEqual(4);
  });

  it('resets cleanly between matches', () => {
    const policy = new RetentionPolicy();
    for (let i = 0; i < 200; i += 1) policy.observe(turn(i));
    policy.reset();
    expect(policy.compactions).toBe(0);
    expect(policy.estimatedTokens).toBe(0);
    expect(policy.retainedTurns).toBe(0);
  });
});

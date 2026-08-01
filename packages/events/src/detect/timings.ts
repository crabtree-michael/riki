/**
 * The two predictive ones: `rune_soon` and `stack_now`.
 *
 * They are the only kinds that fire *before* the moment they are about, which is the only time
 * their advice is actionable — you cannot be told to go for a rune that has already spawned. Both
 * read `packages/world-model`'s clock-only derived rules, which means both work through a pause for
 * free and need no source at all beyond the match clock.
 *
 * **Their deadline is real and their lead time is not a magnitude.** A rune thirty seconds out and
 * a rune eight seconds out are the same event with different urgency, so the difference belongs in
 * `actWithinSeconds` and the urgency curve (§4.2) — which also means the salience threshold, rather
 * than the detector's window, is what actually decides when Riki speaks. The detector's `lead`
 * numbers are an outer bound that keeps this from producing a detection every tick of the match.
 *
 * ⚠ Every rune and stack constant is `packages/world-model`'s and is patch-versioned there. Nothing
 * in this file knows what a rune period is, deliberately: two copies of a patch-sensitive number is
 * how a coach ends up confidently early.
 *
 * See docs/design/coaching-trigger-architecture.md §3.2.
 */

import type { RuneTimings, StackTiming, WorldSnapshot } from '@riki/world-model';
import { DERIVED_IDS } from '@riki/world-model';
import type { EventDetector } from '../contracts.js';
import type { TriggerConfig } from '../config.js';
import type { Detection } from '../types.js';
import { detectionKey } from '../types.js';
import { confidenceOf } from './util.js';

interface Upcoming {
  readonly label: string;
  readonly at: number;
  readonly inSeconds: number;
}

/** The soonest rune of any type that has not already spawned. */
function nextRune(timings: RuneTimings): Upcoming | null {
  const candidates: Upcoming[] = [
    { label: 'bounty', at: timings.nextBountyAt, inSeconds: timings.nextBountyIn },
    { label: 'power', at: timings.nextPowerAt, inSeconds: timings.nextPowerIn },
  ];
  if (timings.nextWaterAt !== null && timings.nextWaterIn !== null) {
    candidates.push({ label: 'water', at: timings.nextWaterAt, inSeconds: timings.nextWaterIn });
  }

  let soonest: Upcoming | null = null;
  for (const candidate of candidates) {
    if (candidate.inSeconds <= 0) continue;
    if (soonest === null || candidate.inSeconds < soonest.inSeconds) soonest = candidate;
  }
  return soonest;
}

export const runeSoon: EventDetector = {
  kind: 'rune_soon',

  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[] {
    const timings = world.derived.get<RuneTimings>(DERIVED_IDS.runeTimings);
    if (timings === null) return [];

    const next = nextRune(timings.value);
    if (next === null || next.inSeconds > cfg.runeLeadSeconds) return [];

    return [
      {
        kind: 'rune_soon',
        // The absolute spawn time is what makes each rune a distinct instance, so the latch
        // clears between runes rather than suppressing every one after the first.
        key: detectionKey('rune_soon', `${next.label}:${String(next.at)}`),
        topic: { of: 'objective', objective: 'rune' },
        magnitude: 1,
        actWithinSeconds: next.inSeconds,
        confidence: confidenceOf(timings),
        text: `${next.label} rune in ${String(Math.round(next.inSeconds))}s`,
        atGameClock: timings.atGameClock ?? world.clock,
      },
    ];
  },
};

export const stackNow: EventDetector = {
  kind: 'stack_now',

  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[] {
    const stack = world.derived.get<StackTiming>(DERIVED_IDS.stackTiming);
    if (stack === null) return [];
    if (stack.value.nextStackIn <= 0 || stack.value.nextStackIn > cfg.stackLeadSeconds) return [];

    return [
      {
        kind: 'stack_now',
        key: detectionKey('stack_now', String(stack.value.nextStackAt)),
        topic: { of: 'objective', objective: 'stack' },
        magnitude: 1,
        actWithinSeconds: stack.value.nextStackIn,
        confidence: confidenceOf(stack),
        text: `stack in ${String(Math.round(stack.value.nextStackIn))}s`,
        atGameClock: stack.atGameClock ?? world.clock,
      },
    ];
  },
};

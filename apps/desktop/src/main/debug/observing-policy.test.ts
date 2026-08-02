/**
 * The two claims `observing-policy.ts` makes, and the second one is the whole feature.
 *
 * 1. It cannot change the decision. Whatever the wrapped policy returns is what leaves.
 * 2. It reports the full grid — every ranked candidate against every gate — which is information
 *    that exists nowhere else in the process.
 */

import { describe, expect, it } from 'vitest';

import type { AdviceTopic, EventId } from '@riki/context';
import type { CoachEvent, Gate, GateContext, TriggerPolicy } from '@riki/events';
import {
  DEFAULT_TRIGGER_CONFIG,
  GATES,
  SUPPRESSION_REASONS,
  createTriggerPolicy,
  detectionKey,
} from '@riki/events';
import { buildWorld } from '@riki/events/testing';
import type { FieldPath, GameClock, MonoMs, WorldSnapshot } from '@riki/world-model';

import type { DebugTickInput } from './contracts.js';
import { createObservingPolicy } from './observing-policy.js';

// -------------------------------------------------------------------------------------------

/**
 * `eventTopic()` is not on `@riki/events`' barrel, so the topic is built here.
 *
 * It is the same one-line construction that function makes, and nothing under test reads it: the
 * gates that consult a topic are the two novelty ones, and every context below has `memory: null`,
 * which those gates are specified to answer "refuses nothing" for.
 */
function topicOf(kind: CoachEvent['kind']): AdviceTopic {
  return { of: 'event', event: kind as EventId };
}

function candidate(kind: CoachEvent['kind'], instance: string, salience: number): CoachEvent {
  const key = detectionKey(kind, instance);
  return {
    id: kind as EventId,
    kind,
    key,
    topic: topicOf(kind),
    salience,
    at: 1_000 as MonoMs,
    detection: {
      kind,
      key,
      topic: topicOf(kind),
      magnitude: 0.5,
      actWithinSeconds: 12,
      confidence: 0.9,
      text: `${kind} ${instance}`,
      atGameClock: null,
    },
  };
}

/** A real world, not a stub — `buildWorld` is what `packages/events`' own gate tests use. */
function liveWorld(phase = 'in_progress'): WorldSnapshot {
  return buildWorld({ now: 1_000, clock: 600 })
    .put('meta.phase' as FieldPath, phase)
    .snapshot();
}

/** A context that passes every gate, so a test can fail exactly one of them. */
function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    world: liveWorld(),
    now: 1_000 as MonoMs,
    clock: 600 as GameClock,
    memory: null,
    cfg: DEFAULT_TRIGGER_CONFIG,
    intensity: 0,
    agentSpeaking: false,
    playerSpeaking: false,
    quietMode: false,
    mutedUntil: null,
    lastSpokeAt: null,
    lastSpokeByKind: new Map(),
    latched: new Set(),
    ...overrides,
  };
}

function observed(
  policy: TriggerPolicy,
  candidates: readonly CoachEvent[],
  ctx: GateContext,
  gates?: readonly Gate[],
): { decision: ReturnType<TriggerPolicy['decide']>; tick: DebugTickInput } {
  // An array rather than a `let`, because TypeScript narrows a `let` assigned only inside a
  // callback back to `null` at the read below and the guard then lints as always-true.
  const reported: DebugTickInput[] = [];
  const observing = createObservingPolicy({
    delegate: policy,
    report: (next) => void reported.push(next),
    tapeSalience: DEFAULT_TRIGGER_CONFIG.tapeSalience,
    worldVersion: () => 42,
    ...(gates === undefined ? {} : { gates }),
  });
  const decision = observing.decide(candidates, ctx);
  const tick = reported[0];
  if (tick === undefined) throw new Error('the observer reported nothing');
  return { decision, tick };
}

// -------------------------------------------------------------------------------------------

describe('it cannot change the decision', () => {
  it('returns the delegate answer identically, whatever it is', () => {
    const answers = [
      { speak: true, event: candidate('ult_ready', 'self', 0.9) },
      { speak: false, reason: 'latched', event: candidate('rune_soon', 'bounty', 0.4) },
      { speak: false, reason: 'below_threshold', event: null },
    ] as const;

    for (const answer of answers) {
      const delegate: TriggerPolicy = { decide: () => answer };
      const { decision } = observed(delegate, [candidate('ult_ready', 'self', 0.9)], context());
      // Identity, not deep equality: nothing here reconstructs a decision, so the object the engine
      // acts on is the object the policy made.
      expect(decision).toBe(answer);
    }
  });

  it('reports even when the delegate refuses everything, and still returns its refusal', () => {
    const { decision, tick } = observed(
      createTriggerPolicy(),
      [candidate('ult_ready', 'self', 0.9)],
      context({ quietMode: true }),
    );

    expect(decision).toEqual({
      speak: false,
      reason: 'quiet_mode',
      event: expect.objectContaining({ kind: 'ult_ready' }) as unknown,
    });
    expect(tick.decision).toEqual({ speak: false, reason: 'quiet_mode', key: 'ult_ready:self' });
  });

  it('survives a gate that throws, and reads it as a refusal rather than a pass', () => {
    const exploding: Gate = {
      reason: 'latched',
      refuses: () => {
        throw new Error('a gate is specified as total; this one is not');
      },
    };

    // The delegate's answer still leaves, and the observer still reports — the alternative is a
    // debug tool that takes the coach down with it.
    const { decision, tick } = observed(
      { decide: () => ({ speak: true, event: candidate('ult_ready', 'self', 0.9) }) },
      [candidate('ult_ready', 'self', 0.9)],
      context(),
      [exploding],
    );

    expect(decision.speak).toBe(true);
    // Reported as a refusal, which is the honest direction: a gate whose answer cannot be relied
    // on should not look like a pass. The inspector runs gates against candidates the shipping
    // path would have short-circuited past, so it is the one place that can provoke this at all.
    expect(tick.candidates[0]?.ladder).toEqual([{ reason: 'latched', refuses: true }]);
  });
});

describe('it reports what nothing else can', () => {
  it('asks every gate about every candidate, including the ones that lost the ranking', () => {
    const { tick } = observed(
      createTriggerPolicy(),
      [candidate('rune_soon', 'bounty', 0.4), candidate('ult_ready', 'self', 0.9)],
      context(),
    );

    // §5.5: the policy consults the gates about the winner alone and there is no fall-through. The
    // inspector's whole reason to exist is that the runner-up's verdicts are still the answer to
    // "why did nobody hear about the other thing".
    expect(tick.candidates.map((each) => each.key)).toEqual(['ult_ready:self', 'rune_soon:bounty']);
    expect(tick.candidates.map((each) => each.rank)).toEqual(['winner', 'ranked-below']);
    for (const each of tick.candidates) {
      expect(each.ladder).toHaveLength(GATES.length);
    }
  });

  it('names all thirteen reasons, in ladder order, whether or not they fired', () => {
    const { tick } = observed(
      createTriggerPolicy(),
      [candidate('ult_ready', 'self', 0.9)],
      context(),
    );

    const reasons = tick.candidates[0]?.ladder.map((gate) => gate.reason);
    expect(reasons).toEqual(GATES.map((gate) => gate.reason));
    // Every member of the real union is reachable — the check `shared/debug.ts` promises in place
    // of restating the union as a string literal type.
    expect([...SUPPRESSION_REASONS].sort()).toEqual([...(reasons ?? [])].sort());
  });

  it('distinguishes the gate that decided from the ones that would also have refused', () => {
    // Latched *and* on a global cooldown. The policy reports `latched`, because that is the first
    // one — §5.2's attribution rule. The grid shows both, which is what stops somebody tuning the
    // cooldown and wondering why nothing changed.
    const { decision, tick } = observed(
      createTriggerPolicy(),
      [candidate('ult_ready', 'self', 0.9)],
      context({
        latched: new Set([detectionKey('ult_ready', 'self')]),
        lastSpokeAt: 900 as MonoMs,
      }),
    );

    expect(decision).toMatchObject({ speak: false, reason: 'latched' });

    const refusing = tick.candidates[0]?.ladder.filter((gate) => gate.refuses).map((g) => g.reason);
    expect(refusing).toEqual(['latched', 'global_cooldown']);
  });

  it('carries the engine state the gates were decided against', () => {
    const { tick } = observed(
      createTriggerPolicy(),
      [candidate('ult_ready', 'self', 0.9)],
      context({
        quietMode: true,
        intensity: 0.7,
        mutedUntil: 5_000 as MonoMs,
        lastSpokeAt: 400 as MonoMs,
        latched: new Set([detectionKey('rune_soon', 'bounty')]),
        lastSpokeByKind: new Map([['ult_ready', 900 as MonoMs]]),
      }),
    );

    // None of this is reachable through `EventEngine`'s public surface — the latch set and the
    // cooldown clocks are private to it, and this is the route that does not require changing
    // `packages/events` to see them.
    expect(tick.gates.quietMode).toBe(true);
    expect(tick.gates.intensity).toBe(0.7);
    expect(tick.gates.mutedUntilMs).toBe(5_000);
    expect(tick.gates.lastSpokeAtMs).toBe(400);
    expect(tick.gates.latched).toEqual(['rune_soon:bounty']);
    expect(tick.gates.kindCooldowns).toEqual([
      { kind: 'ult_ready', remainingMs: DEFAULT_TRIGGER_CONFIG.kindCooldownMs.ult_ready - 100 },
    ]);
  });

  it('omits spent cooldowns rather than listing them as negative', () => {
    const { tick } = observed(
      createTriggerPolicy(),
      [candidate('ult_ready', 'self', 0.9)],
      context({
        now: 10_000_000 as MonoMs,
        lastSpokeByKind: new Map([['ult_ready', 0 as MonoMs]]),
      }),
    );
    expect(tick.gates.kindCooldowns).toEqual([]);
  });

  it('reports which candidates reached the event tape', () => {
    const above = DEFAULT_TRIGGER_CONFIG.tapeSalience + 0.1;
    const below = Math.max(0, DEFAULT_TRIGGER_CONFIG.tapeSalience - 0.1);

    const { tick } = observed(
      createTriggerPolicy(),
      [candidate('ult_ready', 'self', above), candidate('rune_soon', 'bounty', below)],
      context(),
    );

    // The tape is filled before the gates run and regardless of what they decide (§6), so a
    // candidate can be taped and unspoken — which is exactly the pair the `recent:` line depends on
    // and exactly the pair that is invisible from the counters.
    expect(tick.candidates.find((c) => c.key === 'ult_ready:self')?.taped).toBe(true);
    expect(tick.candidates.find((c) => c.key === 'rune_soon:bounty')?.taped).toBe(false);
  });

  it('tapes nothing outside a live match, the way the engine does not', () => {
    const { tick } = observed(
      createTriggerPolicy(),
      [candidate('ult_ready', 'self', 1)],
      context({ world: liveWorld('draft') }),
    );
    // `not_in_match` is the one gate the tape honours: an entry about an Ability Draft timing is
    // wrong, not merely unspoken.
    expect(tick.candidates[0]?.taped).toBe(false);
  });

  it('reports an empty tick, so the panel can tell "nothing detected" from "not running"', () => {
    const { tick } = observed(createTriggerPolicy(), [], context());
    expect(tick.candidates).toEqual([]);
    expect(tick.decision).toEqual({ speak: false, reason: 'below_threshold', key: null });
    expect(tick.worldVersion).toBe(42);
  });
});

/**
 * Ranking, and the rule that there is no second place.
 *
 * The no-fall-through property is the one worth a test rather than a comment: it looks like a
 * missing feature, and the argument for it is that the gates which refuse the winner are mostly
 * about *Riki* — speaking, muted, in a fight, on cooldown — so promoting the runner-up would say
 * something less useful for a reason that applies to it equally (§5.5).
 */

import { describe, expect, it } from 'vitest';
import type { FieldPath } from '@riki/world-model';
import { asGameClock, asMonoMs, fieldPath } from '@riki/world-model';
import { DEFAULT_TRIGGER_CONFIG as CFG } from './config.js';
import type { GateContext } from './contracts.js';
import { createTriggerPolicy, rank } from './policy.js';
import type { CoachEvent, CoachEventKind } from './types.js';
import { detectionKey, eventTopic } from './types.js';
import { buildWorld } from './testing/index.js';

const META_PHASE: FieldPath = fieldPath('meta', 'phase');
const NOW = asMonoMs(0);

function candidate(kind: CoachEventKind, salience: number, instance = 'a'): CoachEvent {
  return {
    id: kind as CoachEvent['id'],
    kind,
    key: detectionKey(kind, instance),
    topic: eventTopic(kind),
    salience,
    detection: {
      kind,
      key: detectionKey(kind, instance),
      topic: eventTopic(kind),
      magnitude: 1,
      actWithinSeconds: null,
      confidence: 1,
      text: kind,
      atGameClock: asGameClock(600),
    },
    at: NOW,
  };
}

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    world: buildWorld().put(META_PHASE, 'in_progress').snapshot(),
    now: NOW,
    clock: asGameClock(600),
    memory: null,
    cfg: CFG,
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

describe('rank', () => {
  it('puts the most salient first', () => {
    const ordered = rank([
      candidate('stack_now', 0.4),
      candidate('low_hp_no_escape', 0.9),
      candidate('rune_soon', 0.6),
    ]);
    expect(ordered.map((c) => c.kind)).toEqual(['low_hp_no_escape', 'rune_soon', 'stack_now']);
  });

  it('is a total order, so a tie does not depend on detector registration order', () => {
    const byKey = rank([candidate('rune_soon', 0.5, 'b'), candidate('rune_soon', 0.5, 'a')]);
    const reversed = rank([candidate('rune_soon', 0.5, 'a'), candidate('rune_soon', 0.5, 'b')]);
    expect(byKey.map((c) => c.key)).toEqual(reversed.map((c) => c.key));
  });

  it('does not mutate what it was given', () => {
    const input = [candidate('stack_now', 0.1), candidate('low_hp_no_escape', 0.9)];
    rank(input);
    expect(input[0]?.kind).toBe('stack_now');
  });
});

describe('one trigger, one utterance', () => {
  const policy = createTriggerPolicy();

  it('speaks the winner and never mentions the rest', () => {
    const decision = policy.decide(
      [candidate('stack_now', 0.4), candidate('low_hp_no_escape', 0.9)],
      context(),
    );
    expect(decision.speak).toBe(true);
    expect(decision.event?.kind).toBe('low_hp_no_escape');
  });

  it('does not fall through to the runner-up when the winner is refused', () => {
    const winner = candidate('low_hp_no_escape', 0.9);
    const decision = policy.decide(
      [winner, candidate('stack_now', 0.4)],
      context({
        latched: new Set([winner.key]),
      }),
    );

    expect(decision.speak).toBe(false);
    expect(decision.event?.kind).toBe('low_hp_no_escape');
  });

  it('reports nothing-detected as a null event rather than as a refusal', () => {
    const decision = policy.decide([], context());
    expect(decision.speak).toBe(false);
    expect(decision.event).toBeNull();
  });
});

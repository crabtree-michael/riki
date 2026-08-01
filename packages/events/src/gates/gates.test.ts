/**
 * Thirteen gates, and the order they are asked in.
 *
 * The gate-order block is the one that is easy to under-weight: it has no user-visible behaviour,
 * and it is what §5.4's tuning signal is *made of*. A refusal attributed to the wrong gate sends
 * whoever is tuning the thresholds to the wrong number, and nothing else in the system would notice.
 */

import { describe, expect, it } from 'vitest';
import type { FieldPath, HeroId, MonoMs } from '@riki/world-model';
import { asGameClock, asMonoMs, fieldPath } from '@riki/world-model';
import { DEFAULT_TRIGGER_CONFIG as CFG } from '../config.js';
import type { GateContext } from '../contracts.js';
import type { CoachEvent } from '../types.js';
import { detectionKey, eventTopic } from '../types.js';
import { GATES } from './index.js';
import { createTriggerPolicy } from '../policy.js';
import { adviceRecord, buildWorld, fakeCoachingMemory } from '../testing/index.js';

const META_PHASE: FieldPath = fieldPath('meta', 'phase');
const META_MODE: FieldPath = fieldPath('meta', 'mode');
const SF = 'sf' as HeroId;
const NOW = asMonoMs(1_000_000);

function inMatch() {
  return buildWorld().put(META_PHASE, 'in_progress');
}

function candidate(overrides: Partial<CoachEvent> = {}): CoachEvent {
  return {
    id: 'enemy_missing' as CoachEvent['id'],
    kind: 'enemy_missing',
    key: detectionKey('enemy_missing', 'sf'),
    topic: { of: 'hero', hero: SF },
    salience: 1,
    detection: {
      kind: 'enemy_missing',
      key: detectionKey('enemy_missing', 'sf'),
      topic: { of: 'hero', hero: SF },
      magnitude: 1,
      actWithinSeconds: null,
      confidence: 1,
      text: 'sf unseen 40s',
      atGameClock: asGameClock(600),
    },
    at: NOW,
    ...overrides,
  };
}

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    world: inMatch().snapshot(),
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

/** The reason the ladder settles on, or null when everything passed. */
function refusal(event: CoachEvent, ctx: GateContext): string | null {
  const decision = createTriggerPolicy().decide([event], ctx);
  return decision.speak ? null : decision.reason;
}

describe('the ladder passes a clean candidate', () => {
  it('speaks when nothing refuses', () => {
    expect(refusal(candidate(), context())).toBeNull();
  });
});

describe('not_in_match', () => {
  it('refuses outside a live match', () => {
    const world = buildWorld().put(META_PHASE, 'draft');
    expect(refusal(candidate(), context({ world: world.snapshot() }))).toBe('not_in_match');
  });

  it('refuses in a mode the standard timings are wrong for', () => {
    const world = inMatch().put(META_MODE, 'ABILITY_DRAFT');
    expect(refusal(candidate(), context({ world: world.snapshot() }))).toBe('not_in_match');
  });

  it('allows an unknown mode, because failing closed would disable the product silently', () => {
    const world = inMatch().put(META_MODE, 'some_new_mode_valve_added');
    expect(refusal(candidate(), context({ world: world.snapshot() }))).toBeNull();
  });
});

describe('the player’s own instructions', () => {
  it('refuses in quiet mode', () => {
    expect(refusal(candidate(), context({ quietMode: true }))).toBe('quiet_mode');
  });

  it('refuses while muted, and stops when the mute expires', () => {
    const later = asMonoMs(NOW + 60_000);
    expect(refusal(candidate(), context({ mutedUntil: later }))).toBe('muted');
    expect(refusal(candidate(), context({ mutedUntil: asMonoMs(NOW - 1) }))).toBeNull();
  });
});

describe('one trigger, one utterance', () => {
  it('drops a trigger while a turn is open', () => {
    expect(refusal(candidate(), context({ agentSpeaking: true }))).toBe('agent_speaking');
  });

  it('never speaks over the player', () => {
    expect(refusal(candidate(), context({ playerSpeaking: true }))).toBe('player_speaking');
  });
});

describe('high_intensity', () => {
  it('refuses mid-fight', () => {
    expect(refusal(candidate(), context({ intensity: CFG.intensityThreshold }))).toBe(
      'high_intensity',
    );
  });

  it('passes below the threshold', () => {
    expect(refusal(candidate(), context({ intensity: CFG.intensityThreshold - 0.01 }))).toBeNull();
  });
});

describe('the latch, and how it differs from a cooldown', () => {
  it('refuses a condition that has been true since it was mentioned', () => {
    const event = candidate();
    expect(refusal(event, context({ latched: new Set([event.key]) }))).toBe('latched');
  });

  it('does not refuse a different instance of the same kind', () => {
    const other = candidate({ key: detectionKey('enemy_missing', 'cm') });
    expect(refusal(other, context({ latched: new Set([candidate().key]) }))).toBeNull();
  });

  it('is independent of the cooldown — the case §5.3 exists for', () => {
    const event = candidate();
    // Cooldown expired, condition still true: only the latch stands between this and a repeat.
    const ctx = context({
      latched: new Set([event.key]),
      lastSpokeAt: asMonoMs(NOW - CFG.globalCooldownMs - 1),
      lastSpokeByKind: new Map([
        ['enemy_missing', asMonoMs(NOW - CFG.kindCooldownMs.enemy_missing - 1)],
      ]),
    });
    expect(refusal(event, ctx)).toBe('latched');
  });
});

describe('cooldowns', () => {
  it('refuses inside the per-kind cooldown', () => {
    const ctx = context({
      lastSpokeByKind: new Map<CoachEvent['kind'], MonoMs>([['enemy_missing', asMonoMs(NOW - 1)]]),
    });
    expect(refusal(candidate(), ctx)).toBe('kind_cooldown');
  });

  it('does not apply one kind’s cooldown to another', () => {
    const ctx = context({
      lastSpokeByKind: new Map<CoachEvent['kind'], MonoMs>([['rune_soon', asMonoMs(NOW - 1)]]),
      // Far enough back that the global cooldown is not what is being measured.
      lastSpokeAt: asMonoMs(NOW - CFG.globalCooldownMs - 1),
    });
    expect(refusal(candidate(), ctx)).toBeNull();
  });

  it('refuses inside the global cooldown', () => {
    expect(refusal(candidate(), context({ lastSpokeAt: asMonoMs(NOW - 1) }))).toBe(
      'global_cooldown',
    );
  });
});

describe('novelty', () => {
  const topic = { of: 'hero', hero: SF } as const;

  it('refuses advice the player acted on', () => {
    const memory = fakeCoachingMemory(
      [adviceRecord(topic, { response: 'followed', lastAt: asGameClock(590) })],
      asGameClock(600),
    );
    expect(refusal(candidate(), context({ memory }))).toBe('already_advised');
  });

  it('refuses advice ignored twice', () => {
    const memory = fakeCoachingMemory(
      [adviceRecord(topic, { response: 'ignored', count: 2, lastAt: asGameClock(590) })],
      asGameClock(600),
    );
    expect(refusal(candidate(), context({ memory }))).toBe('ignored_twice');
  });

  it('allows advice ignored once — twice is the rule, not once', () => {
    const memory = fakeCoachingMemory(
      [adviceRecord(topic, { response: 'ignored', count: 1, lastAt: asGameClock(590) })],
      asGameClock(600),
    );
    expect(refusal(candidate(), context({ memory }))).toBeNull();
  });

  it('allows advice from outside the novelty window', () => {
    const memory = fakeCoachingMemory(
      [adviceRecord(topic, { response: 'followed', lastAt: asGameClock(0) })],
      asGameClock(CFG.noveltyWindowSeconds + 100),
    );
    expect(refusal(candidate(), context({ memory }))).toBeNull();
  });

  it('refuses nothing when no memory is wired — quiet about repetition, not about everything', () => {
    expect(refusal(candidate(), context({ memory: null }))).toBeNull();
  });
});

describe('salience gates', () => {
  it('gives a zero-urgency candidate its own reason', () => {
    expect(refusal(candidate({ salience: 0 }), context())).toBe('stale_window');
  });

  it('refuses below the speak threshold', () => {
    expect(refusal(candidate({ salience: CFG.speakThreshold / 2 }), context())).toBe(
      'below_threshold',
    );
  });
});

describe('gate order', () => {
  it('attributes a doubly-refused candidate to the earlier gate', () => {
    const event = candidate();
    const ctx = context({
      intensity: 1,
      latched: new Set([event.key]),
      lastSpokeAt: asMonoMs(NOW - 1),
      quietMode: true,
    });
    // quiet_mode is gate 2 and beats three later refusals: the player's instruction is the reason
    // whoever is tuning needs to see, not the cooldown that would also have applied.
    expect(refusal(event, ctx)).toBe('quiet_mode');
  });

  it('is the order the ladder is declared in', () => {
    expect(GATES.map((gate) => gate.reason)).toEqual([
      'not_in_match',
      'quiet_mode',
      'muted',
      'agent_speaking',
      'player_speaking',
      'high_intensity',
      'latched',
      'kind_cooldown',
      'global_cooldown',
      'already_advised',
      'ignored_twice',
      'stale_window',
      'below_threshold',
    ]);
  });

  it('has one gate per suppression reason, and no reason without a gate', () => {
    expect(new Set(GATES.map((gate) => gate.reason)).size).toBe(GATES.length);
  });
});

describe('the topic a gate reads', () => {
  it('is the detection’s, so an event-topic kind is gated on its own name', () => {
    const memory = fakeCoachingMemory(
      [adviceRecord(eventTopic('ult_ready'), { response: 'followed', lastAt: asGameClock(590) })],
      asGameClock(600),
    );
    const event = candidate({ kind: 'ult_ready', topic: eventTopic('ult_ready') });
    expect(refusal(event, context({ memory }))).toBe('already_advised');
    expect(refusal(candidate(), context({ memory }))).toBeNull();
  });
});

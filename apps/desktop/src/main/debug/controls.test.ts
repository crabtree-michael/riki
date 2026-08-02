/**
 * The registry, and the three live views the composition root injects in its place.
 *
 * Two families of claim, and they pull in opposite directions on purpose:
 *
 * 1. **It is inert until it is used.** An untouched `DebugControls` produces a config that answers
 *    what `DEFAULT_TRIGGER_CONFIG` answers, gates that refuse what `GATES` refuse, and detectors
 *    that detect what `DETECTORS` detect. `shell.test.ts` makes the same claim end to end; this
 *    makes it about the object.
 * 2. **A change reaches the thing that reads it.** The engine captures `config`, `gates` and
 *    `detectors` once, so what is asserted below is that the *same object* answers differently after
 *    an `apply` — not that a new one would.
 *
 * Plus the boundary: an unknown id reaches nothing, and a locked control refuses and stays put.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CoachEvent, GateContext } from '@riki/events';
import {
  COACH_EVENT_KINDS,
  DEFAULT_TRIGGER_CONFIG,
  GATES,
  SUPPRESSION_REASONS,
  detectionKey,
} from '@riki/events';
import { buildWorld } from '@riki/events/testing';
import type { AdviceTopic, EventId } from '@riki/context';
import type { FieldPath, GameClock, MonoMs, WorldSnapshot } from '@riki/world-model';

import type { DebugControl } from '../../shared/debug.js';
import type { DebugControls, DebugControlsDeps } from './controls.js';
import { createDebugControls } from './controls.js';

// -------------------------------------------------------------------------------------------

interface Harness {
  readonly controls: DebugControls;
  /** What the coach control was told to do, in order. */
  readonly coachSet: string[];
  readonly unpromptedSet: boolean[];
  coachMode: string;
  unprompted: boolean;
}

function harness(overrides: Partial<DebugControlsDeps> = {}): Harness {
  const state = {
    coachMode: 'static',
    unprompted: false,
    coachSet: [] as string[],
    unpromptedSet: [] as boolean[],
  };

  const controls = createDebugControls({
    coach: {
      configured: 'static',
      current: () => state.coachMode,
      set: (mode) => {
        state.coachSet.push(mode);
        state.coachMode = mode;
      },
      available: () => true,
    },
    unprompted: {
      configured: false,
      current: () => state.unprompted,
      set: (on) => {
        state.unpromptedSet.push(on);
        state.unprompted = on;
      },
    },
    ...overrides,
  });

  return {
    controls,
    coachSet: state.coachSet,
    unpromptedSet: state.unpromptedSet,
    get coachMode() {
      return state.coachMode;
    },
    get unprompted() {
      return state.unprompted;
    },
  };
}

function find(controls: DebugControls, id: string): DebugControl {
  const found = controls.list().find((control) => control.id === id);
  if (found === undefined) throw new Error(`no control ${id}`);
  return found;
}

function topicOf(kind: CoachEvent['kind']): AdviceTopic {
  return { of: 'event', event: kind as EventId };
}

function candidate(kind: CoachEvent['kind'] = 'ult_ready', instance = 'self'): CoachEvent {
  const key = detectionKey(kind, instance);
  return {
    id: kind as EventId,
    kind,
    key,
    topic: topicOf(kind),
    salience: 0.9,
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

function liveWorld(): WorldSnapshot {
  return buildWorld({ now: 1_000, clock: 600 })
    .put('meta.phase' as FieldPath, 'in_progress')
    .snapshot();
}

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

/** Every numeric field of `TriggerConfig`, read off the shipped defaults rather than restated. */
const NUMERIC_FIELDS = Object.entries(DEFAULT_TRIGGER_CONFIG)
  .filter(([, value]) => typeof value === 'number')
  .map(([key]) => key);

// -------------------------------------------------------------------------------------------

describe('inert until it is used', () => {
  it('answers exactly what the shipped config answers', () => {
    const { controls } = harness();

    // Field by field rather than a deep-equal, because `config` is getter-backed and a structural
    // comparison would pass on an object that had the right *shape* and the wrong reads.
    for (const key of NUMERIC_FIELDS) {
      expect(controls.config[key as keyof typeof controls.config]).toBe(
        DEFAULT_TRIGGER_CONFIG[key as keyof typeof DEFAULT_TRIGGER_CONFIG],
      );
    }
    for (const kind of COACH_EVENT_KINDS) {
      expect(controls.config.kindWeight[kind]).toBe(DEFAULT_TRIGGER_CONFIG.kindWeight[kind]);
      expect(controls.config.kindCooldownMs[kind]).toBe(
        DEFAULT_TRIGGER_CONFIG.kindCooldownMs[kind],
      );
    }
    expect(controls.config.blockedModes).toEqual(DEFAULT_TRIGGER_CONFIG.blockedModes);
    expect(controls.config.escapeItems).toEqual(DEFAULT_TRIGGER_CONFIG.escapeItems);
  });

  it('refuses exactly what the real ladder refuses', () => {
    const { controls } = harness();
    const event = candidate();
    const latched = context({ latched: new Set([event.key]) });

    expect(controls.gates).toHaveLength(GATES.length);
    for (const [index, gate] of controls.gates.entries()) {
      const real = GATES[index];
      expect(gate.reason).toBe(real?.reason);
      expect(gate.refuses(event, latched)).toBe(real?.refuses(event, latched));
    }
  });

  it('detects exactly what the real detectors detect', () => {
    const { controls } = harness();
    const world = liveWorld();

    expect(controls.detectors).toHaveLength(COACH_EVENT_KINDS.length);
    for (const detector of controls.detectors) {
      expect(detector.detect(world, controls.config)).toEqual(
        detector.detect(world, DEFAULT_TRIGGER_CONFIG),
      );
    }
  });

  it('reports nothing as overridden', () => {
    expect(
      harness()
        .controls.list()
        .some((control) => control.overridden),
    ).toBe(false);
  });
});

describe('the table covers what it claims to', () => {
  it('has a row for every number in packages/events/src/config.ts', () => {
    const ids = new Set(
      harness()
        .controls.list()
        .map((control) => control.id),
    );
    // The compiler already enforces this — `SCALARS` is a total `Record` over the numeric keys —
    // and this asserts the same thing from the outside, because a totality that is only structural
    // would be satisfied by a row that never made it into the registry.
    for (const key of NUMERIC_FIELDS) expect(ids).toContain(`trigger.${key}`);
  });

  it('has a row for every kind and every gate', () => {
    const ids = new Set(
      harness()
        .controls.list()
        .map((control) => control.id),
    );
    for (const kind of COACH_EVENT_KINDS) {
      expect(ids).toContain(`trigger.kindWeight.${kind}`);
      expect(ids).toContain(`trigger.kindCooldownMs.${kind}`);
      expect(ids).toContain(`detector.${kind}`);
    }
    for (const reason of SUPPRESSION_REASONS) expect(ids).toContain(`gate.${reason}`);
  });

  it('gives every number a range that contains its own default', () => {
    for (const control of harness().controls.list()) {
      if (control.kind !== 'number') continue;
      const base = control.base as number;
      // A range that excluded the shipped value would make the first click on that control move it,
      // which is the least trustworthy thing a tuning surface could do.
      expect(base).toBeGreaterThanOrEqual(control.min ?? -Infinity);
      expect(base).toBeLessThanOrEqual(control.max ?? Infinity);
    }
  });
});

describe('a change reaches the object the engine captured', () => {
  it('moves a threshold on the config the engine already holds', () => {
    const { controls } = harness();
    const config = controls.config;

    expect(controls.apply('trigger.speakThreshold', 0.05).ok).toBe(true);

    // The same object, captured before the change — which is the only reading that matters, because
    // `createEventEngine` takes `config` once at construction and never asks again.
    expect(config.speakThreshold).toBe(0.05);
    expect(find(controls, 'trigger.speakThreshold').overridden).toBe(true);
    expect(find(controls, 'trigger.speakThreshold').base).toBe(
      DEFAULT_TRIGGER_CONFIG.speakThreshold,
    );
  });

  it('moves a per-kind number without touching its neighbours', () => {
    const { controls } = harness();
    controls.apply('trigger.kindCooldownMs.rune_soon', 0);

    expect(controls.config.kindCooldownMs.rune_soon).toBe(0);
    expect(controls.config.kindCooldownMs.ult_ready).toBe(
      DEFAULT_TRIGGER_CONFIG.kindCooldownMs.ult_ready,
    );
  });

  it('stops a gate refusing without removing it from the ladder', () => {
    const { controls } = harness();
    const event = candidate();
    const latched = context({ latched: new Set([event.key]) });
    const gate = controls.gates.find((each) => each.reason === 'latched');

    expect(gate?.refuses(event, latched)).toBe(true);
    controls.apply('gate.latched', false);

    expect(gate?.refuses(event, latched)).toBe(false);
    // Still thirteen. A switched-off gate goes on being displayed and evaluated everywhere the grid
    // is drawn — the point is to see what it *would* have said, not to hide it.
    expect(controls.gates).toHaveLength(GATES.length);
    expect(controls.gates.map((each) => each.reason)).toEqual(GATES.map((each) => each.reason));
  });

  it('silences a detector without removing it', () => {
    const { controls } = harness();
    const world = buildWorld({ now: 1_000, clock: 600 })
      .put('meta.phase' as FieldPath, 'in_progress')
      .snapshot();

    const detector = controls.detectors.find((each) => each.kind === 'enemy_missing');
    controls.apply('detector.enemy_missing', false);

    expect(detector?.detect(world, controls.config)).toEqual([]);
    expect(controls.detectors).toHaveLength(COACH_EVENT_KINDS.length);
  });

  it('routes the coach and quiet mode to the shell rather than holding them', () => {
    const rig = harness();
    rig.controls.apply('coach.mode', 'llm');
    rig.controls.apply('coach.unprompted', true);

    // Held nowhere here: the shell owns both, because only it can resolve `llm` to `static` and
    // only it can reach a driver that is rebuilt every match.
    expect(rig.coachSet).toEqual(['llm']);
    expect(rig.unpromptedSet).toEqual([true]);
    expect(find(rig.controls, 'coach.mode').value).toBe('llm');
    expect(find(rig.controls, 'coach.mode').overridden).toBe(true);
  });

  it('shows the mode the shell settled on, not the one that was asked for', () => {
    const rig = harness({
      coach: {
        configured: 'static',
        current: () => 'static',
        // What `setCoachMode` does with no API key behind it: resolves `llm` back to `static`.
        set: () => undefined,
        available: () => false,
      },
    });

    expect(rig.controls.apply('coach.mode', 'llm').ok).toBe(true);
    expect(find(rig.controls, 'coach.mode').value).toBe('static');
    expect(find(rig.controls, 'coach.mode').overridden).toBe(false);
  });
});

describe('what it will not do', () => {
  it('reaches nothing for an id that is not in the registry', () => {
    const { controls } = harness();
    const outcome = controls.apply('trigger.nope', 1);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('trigger.nope');
  });

  it('refuses the two gates that are the player talking, and leaves them refusing', () => {
    const { controls } = harness();
    const muted = context({ mutedUntil: 5_000 as MonoMs, now: 1_000 as MonoMs });

    for (const reason of ['quiet_mode', 'muted']) {
      expect(find(controls, `gate.${reason}`).locked).not.toBeNull();
      expect(controls.apply(`gate.${reason}`, false).ok).toBe(false);
      expect(find(controls, `gate.${reason}`).value).toBe(true);
    }

    expect(
      controls.gates.find((gate) => gate.reason === 'muted')?.refuses(candidate(), muted),
    ).toBe(true);
    expect(
      controls.gates
        .find((gate) => gate.reason === 'quiet_mode')
        ?.refuses(candidate(), context({ quietMode: true })),
    ).toBe(true);
  });

  it('refuses the list-valued settings rather than pretending they are editable', () => {
    const { controls } = harness();
    expect(find(controls, 'trigger.blockedModes').locked).not.toBeNull();
    expect(controls.apply('trigger.blockedModes', 'turbo').ok).toBe(false);
    expect(controls.config.blockedModes).toEqual(DEFAULT_TRIGGER_CONFIG.blockedModes);
  });

  it('refuses a value of the wrong shape', () => {
    const { controls } = harness();
    expect(controls.apply('trigger.speakThreshold', true).ok).toBe(false);
    expect(controls.apply('detector.ult_ready', 3).ok).toBe(false);
    expect(controls.apply('coach.mode', 'shouty').ok).toBe(false);
    expect(controls.config.speakThreshold).toBe(DEFAULT_TRIGGER_CONFIG.speakThreshold);
  });

  it('reports a change only when one happened', () => {
    const onChanged = vi.fn();
    const { controls } = harness({ onChanged });

    controls.apply('trigger.speakThreshold', 0.1);
    controls.apply('gate.muted', false);
    controls.apply('nope', 1);

    expect(onChanged.mock.calls).toEqual([['trigger.speakThreshold', 0.1]]);
  });
});

describe('numbers are clamped and snapped', () => {
  it('holds a value inside the control range', () => {
    const { controls } = harness();
    controls.apply('trigger.speakThreshold', 9);
    expect(controls.config.speakThreshold).toBe(1);
    controls.apply('trigger.speakThreshold', -4);
    expect(controls.config.speakThreshold).toBe(0);
  });

  it('snaps to the step, without floating-point litter', () => {
    const { controls } = harness();
    controls.apply('trigger.speakThreshold', 0.31);
    // 0.05 grid. The assertion is on the exact value rather than a closeTo, because the number is
    // displayed to three decimals and `0.30000000000000004` is what a naive step arithmetic gives.
    expect(controls.config.speakThreshold).toBe(0.3);
  });

  it('does not count a value stepped back to the config as an override', () => {
    const { controls } = harness();
    controls.apply('trigger.speakThreshold', 0.35);
    expect(find(controls, 'trigger.speakThreshold').overridden).toBe(true);

    controls.apply('trigger.speakThreshold', DEFAULT_TRIGGER_CONFIG.speakThreshold);
    expect(find(controls, 'trigger.speakThreshold').overridden).toBe(false);
  });
});

describe('reset', () => {
  it('puts everything back, including the two the shell owns', () => {
    const rig = harness();
    rig.controls.apply('trigger.speakThreshold', 0.05);
    rig.controls.apply('trigger.kindWeight.ult_ready', 1);
    rig.controls.apply('gate.latched', false);
    rig.controls.apply('detector.rune_soon', false);
    rig.controls.apply('coach.unprompted', true);

    rig.controls.reset();

    expect(rig.controls.config.speakThreshold).toBe(DEFAULT_TRIGGER_CONFIG.speakThreshold);
    expect(rig.controls.config.kindWeight.ult_ready).toBe(
      DEFAULT_TRIGGER_CONFIG.kindWeight.ult_ready,
    );
    expect(rig.controls.list().some((control) => control.overridden)).toBe(false);
    expect(rig.unprompted).toBe(false);

    const event = candidate();
    const latched = context({ latched: new Set([event.key]) });
    expect(
      rig.controls.gates.find((gate) => gate.reason === 'latched')?.refuses(event, latched),
    ).toBe(true);
  });
});

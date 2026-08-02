/**
 * The LLM coach, end to end, with no key and no network.
 *
 * `FakeCoachModel` is what makes this Tier 1 (REPO_SKELETON.md §5.2): a real world model, the real
 * eight detectors, the real signal reader and record, and a scripted model. Everything this package
 * decides on its own is asserted here; the only thing that cannot be is the judgement itself, which
 * is the honest boundary of what is testable.
 *
 * The file is organised around the four decisions this coach was built to, because those are the
 * things a future change is most likely to quietly undo:
 *
 * 1. **The model decides.** No salience floor, no cooldown, no latch, no novelty gate — the six
 *    skips are the player's controls and physics, and nothing else refuses.
 * 2. **Push-only.** A fresh detection is the only thing that wakes it. There is no timer.
 * 3. **Soft pacing.** A gap between asks and a deadline that checks rather than cancels.
 * 4. **ADR-0013.** The topic on an utterance is the detector's, and a judgement that names anything
 *    else is discarded rather than repaired.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildWorld } from '@riki/events/testing';
import type { AbilityState, FieldPath, HeroId, MapPosition } from '@riki/world-model';
import { fieldPath, heroField } from '@riki/world-model';
import { createLlmCoach } from './coach.js';
import { withCoachConfig } from './config.js';
import { DEFAULT_COACH_CONFIG } from './config.js';
import type { CoachUtterance } from './types.js';
import {
  createFakeCoachModel,
  createManualClock,
  declines,
  fixedNarrator,
  speaks,
  speaksAbout,
} from './testing/index.js';

const META_PHASE: FieldPath = fieldPath('meta', 'phase');
const META_CLOCK: FieldPath = fieldPath('meta', 'clock');
const SELF_ALIVE: FieldPath = fieldPath('self', 'alive');
const SELF_HEALTH: FieldPath = fieldPath('self', 'health');
const SELF_MANA: FieldPath = fieldPath('self', 'mana');
const SELF_ABILITIES: FieldPath = fieldPath('self', 'abilities');
const SF = 'sf' as HeroId;
const HERE: MapPosition = { x: 0, y: 0 };

function ult(castable: boolean): AbilityState {
  return { id: 'requiem', level: 3, cooldown: 0, castable, isUltimate: true } as AbilityState;
}

/**
 * A world in which `ult_ready` fires.
 *
 * Every field is re-`put` on each refresh rather than only the one under test: `self.*` expires at
 * 60 s of game time and a position at 20 s, so a test that advances the clock without re-observing
 * is asserting that every source went quiet — which produces the right answer for entirely the
 * wrong reason. The `agent-context` skill records this trap; it cost two rounds of confusing red.
 */
function coachable(world = buildWorld({ clock: 600 }), ultUp = true) {
  return world
    .put(META_PHASE, 'in_progress')
    .put(META_CLOCK, 600)
    .put(SELF_ALIVE, true)
    .put(SELF_HEALTH, { current: 800, max: 1000 })
    .put(SELF_MANA, { current: 500, max: 1000 })
    .put(SELF_ABILITIES, [ult(ultUp)])
    .put(heroField('enemies', SF, 'position'), HERE);
}

/**
 * Take the condition away and bring it back, so the next read is genuinely fresh.
 *
 * Two bumps, because `fresh` is *not true at the last consultation, or false at some point since* —
 * the signal reader prunes a key the detectors stop reporting. One bump would leave the condition
 * continuously true, which is exactly the case that must **not** re-consult.
 */
async function recur(h: ReturnType<typeof harness>): Promise<void> {
  h.world.advance(5);
  coachable(h.world, false);
  await bump(h);
  h.world.advance(5);
  coachable(h.world, true);
  await bump(h);
}

function harness(options: { narration?: string; gapSeconds?: number } = {}) {
  const world = coachable();
  const clock = createManualClock(0);
  const model = createFakeCoachModel();
  const spoken: CoachUtterance[] = [];
  const declinedReasons: string[] = [];

  const coach = createLlmCoach({
    world: world.reader(),
    narrator: fixedNarrator(options.narration ?? 'clock 10:00\nself hp 80%'),
    model,
    clock,
    // Zero gap by default so a test that is not about pacing does not have to think about it.
    config: withCoachConfig({ minConsultGapSeconds: options.gapSeconds ?? 0 }),
  });

  coach.onUtterance((utterance) => spoken.push(utterance));
  coach.onDeclined((reason) => declinedReasons.push(reason));
  const stop = coach.start();

  return { world, clock, model, coach, spoken, declined: declinedReasons, stop };
}

/** `commit()` is what fires `onVersion`; the coach's own work is async behind it. */
async function bump(h: ReturnType<typeof harness>): Promise<void> {
  h.world.commit();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('the trigger is push-only', () => {
  it('makes no request at all when nothing new is detected', async () => {
    const h = harness();
    // A world with no detectable condition: no ult, so `ult_ready` does not fire.
    h.world.put(SELF_ABILITIES, [ult(false)]);
    await bump(h);

    expect(h.model.seen).toHaveLength(0);
    h.coach.dispose();
  });

  it('consults when a detector reports something that has just become true', async () => {
    const h = harness();
    h.model.push(declines());
    await bump(h);

    expect(h.model.seen).toHaveLength(1);
    expect(h.model.seen[0]?.signals.some((s) => s.kind === 'ult_ready')).toBe(true);
    h.coach.dispose();
  });

  it('does not consult again while the same condition merely stays true', async () => {
    const h = harness();
    h.model.push(declines());
    await bump(h);
    expect(h.model.seen).toHaveLength(1);

    // Same world, same conditions, another version bump. Nothing is *new*, so nothing is asked.
    h.world.advance(1);
    coachable(h.world);
    await bump(h);

    expect(h.model.seen).toHaveLength(1);
    h.coach.dispose();
  });

  it('has no timer: a started coach left alone never consults', async () => {
    const h = harness();
    // No `commit()`. If a cadence existed, something would eventually fire; there is none, so the
    // only way to reach the model is a version bump.
    await Promise.resolve();
    await Promise.resolve();

    expect(h.model.seen).toHaveLength(0);
    h.coach.dispose();
  });

  it('does not consult at match start before any detection', async () => {
    // `start()` is called inside `harness`. A priming consultation would show up here, and it was
    // deliberately removed: with no signal there is nothing to attribute an answer to.
    const h = harness();
    await Promise.resolve();

    expect(h.model.seen).toHaveLength(0);
    h.coach.dispose();
  });
});

describe('the pacing is soft, and it is on asking rather than on speaking', () => {
  it('collapses a burst of new conditions into one consultation', async () => {
    const h = harness({ gapSeconds: 2 });
    h.model.push(declines());
    h.model.push(declines());
    await bump(h);
    expect(h.model.seen).toHaveLength(1);

    // A second, different condition becomes true 100 ms later — inside the gap. `enemy_missing`
    // fires once the position is stale enough, so this is a genuinely new signal rather than the
    // same one flapping.
    h.clock.advance(100);
    h.world.advance(40);
    coachable(h.world);
    h.world.put(heroField('enemies', SF, 'position'), HERE, { ageSeconds: 40 });
    await bump(h);

    expect(h.model.seen).toHaveLength(1);
    h.coach.dispose();
  });

  it('speaks a late answer whose condition is still true', async () => {
    const h = harness();
    h.model.block();
    h.model.push(speaksAbout('Your ult is up — look for the fight.'));
    h.world.commit();
    await Promise.resolve();

    // Well past any deadline the signals declared. Nothing cancelled the call.
    h.clock.advance(60_000);
    h.model.release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The condition is still true — the world was never changed — so a late line is still spoken.
    expect(h.spoken).toHaveLength(1);
    h.coach.dispose();
  });
});

describe('nothing deterministic gates the model', () => {
  it('consults even when the same moment would be latched and cooled down', async () => {
    const h = harness();
    h.model.push(speaksAbout('First.'));
    await bump(h);
    expect(h.spoken).toHaveLength(1);

    // Under `packages/events` this exact condition would now be latched and on a kind cooldown, and
    // the second occurrence would be refused without the model ever seeing it. Here it goes back to
    // the model, which is the whole of the decision.
    h.model.push(speaksAbout('Again, and the model chose to.'));
    await recur(h);

    expect(h.spoken.length).toBeGreaterThanOrEqual(2);
    h.coach.dispose();
  });

  it('counts exactly six skip reasons, and none of them is a policy', () => {
    // A seventh needs an ADR (`types.ts`). The assertion is the tripwire for that rule.
    expect(DEFAULT_COACH_CONFIG).toBeDefined();
    const h = harness();
    expect(Object.keys(h.coach.counters().skipped).sort()).toEqual([
      'agent_speaking',
      'in_flight',
      'muted',
      'no_world',
      'player_speaking',
      'quiet_mode',
    ]);
    h.coach.dispose();
  });
});

describe("the player's off switches work with the model unreachable", () => {
  it('asks nothing in quiet mode', async () => {
    const h = harness();
    h.coach.setQuietMode(true);
    await bump(h);

    expect(h.model.seen).toHaveLength(0);
    expect(h.coach.counters().skipped.quiet_mode).toBe(1);
    h.coach.dispose();
  });

  it('asks nothing while muted, and asks again once the mute expires', async () => {
    const h = harness();
    h.coach.setMuted(10_000 as never);
    await bump(h);
    expect(h.model.seen).toHaveLength(0);
    expect(h.coach.counters().skipped.muted).toBe(1);

    // The detection that arrived during the mute is *deferred, not spent*: freshness only advances
    // once the model has actually been shown the signals, so the same condition is still new here.
    h.clock.advance(20_000);
    h.coach.setMuted(null);
    h.model.push(declines());
    h.world.advance(1);
    coachable(h.world);
    await bump(h);

    expect(h.model.seen).toHaveLength(1);
    h.coach.dispose();
  });

  it('asks nothing while the agent or the player is speaking', async () => {
    const h = harness();
    h.coach.setAgentSpeaking(true);
    await bump(h);
    expect(h.coach.counters().skipped.agent_speaking).toBe(1);

    h.coach.setAgentSpeaking(false);
    h.coach.setPlayerSpeaking(true);
    h.world.advance(1);
    coachable(h.world);
    await bump(h);
    expect(h.coach.counters().skipped.player_speaking).toBe(1);

    expect(h.model.seen).toHaveLength(0);
    h.coach.dispose();
  });

  it('asks nothing when the narrator has nothing to say', async () => {
    const h = harness({ narration: '' });
    await bump(h);

    expect(h.model.seen).toHaveLength(0);
    expect(h.coach.counters().skipped.no_world).toBe(1);
    h.coach.dispose();
  });

  it('holds one consultation at a time', async () => {
    const h = harness();
    h.model.block();
    h.model.push(declines());
    h.world.commit();
    await Promise.resolve();

    // A second trigger while the first is outstanding.
    h.world.advance(1);
    coachable(h.world);
    h.world.commit();
    await Promise.resolve();

    expect(h.coach.counters().skipped.in_flight).toBeGreaterThanOrEqual(1);
    h.model.release();
    h.coach.dispose();
  });
});

describe('the topic comes from the detector, never from the model (ADR-0013)', () => {
  it('takes kind, key and topic off the signal the judgement named', async () => {
    const h = harness();
    h.model.push(declines());
    await bump(h);
    const key = h.model.seen[0]?.signals[0]?.key;
    expect(key).toBeDefined();

    h.model.push(speaks('Your ult is up.', { about: key ?? null }));
    await recur(h);

    const utterance = h.spoken.at(-1);
    expect(utterance).toBeDefined();
    expect(utterance?.key).toBe(key);
    expect(utterance?.kind).toBe('ult_ready');
    // The detector's own closed-union topic, not anything derived from the model's prose.
    expect(utterance?.topic).toEqual({ of: 'event', event: 'ult_ready' });
    h.coach.dispose();
  });

  it('discards a judgement that names a signal it was not shown', async () => {
    const h = harness();
    h.model.push(
      speaks('Something about a hero nobody detected.', { about: 'enemy_missing:zeus' as never }),
    );
    await bump(h);

    expect(h.spoken).toHaveLength(0);
    expect(h.coach.counters().discarded).toBe(1);
    expect(h.declined.join(' ')).toContain('discarded');
    h.coach.dispose();
  });

  it('discards a judgement that speaks without naming anything', async () => {
    const h = harness();
    h.model.push(speaks('A thought with no subject.', { about: null }));
    await bump(h);

    expect(h.spoken).toHaveLength(0);
    expect(h.coach.counters().discarded).toBe(1);
    h.coach.dispose();
  });
});

describe('an answer that cannot be used is silence', () => {
  it('counts a failed run apart from a decline', async () => {
    const h = harness();
    h.model.push(null);
    await bump(h);

    const counters = h.coach.counters();
    expect(counters.failed).toBe(1);
    expect(counters.declined).toBe(0);
    expect(h.spoken).toHaveLength(0);
    h.coach.dispose();
  });

  it('records the model reasoning when it declines', async () => {
    const h = harness();
    h.model.push(declines('they can see their own health bar'));
    await bump(h);

    expect(h.coach.counters().declined).toBe(1);
    expect(h.declined).toContain('they can see their own health bar');
    h.coach.dispose();
  });

  it('discards a line longer than maxSayChars rather than truncating it', async () => {
    const h = harness();
    h.model.push(declines());
    await bump(h);
    const key = h.model.seen[0]?.signals[0]?.key ?? null;

    h.model.push(speaks('x'.repeat(DEFAULT_COACH_CONFIG.maxSayChars + 1), { about: key }));
    await recur(h);

    expect(h.spoken).toHaveLength(0);
    expect(h.coach.counters().discarded).toBeGreaterThanOrEqual(1);
    h.coach.dispose();
  });
});

describe('housekeeping', () => {
  it('closes the model when disposed', () => {
    const h = harness();
    h.coach.dispose();
    expect(h.model.closed).toBe(true);
  });

  it('keeps tracing off by default, because a stimulus contains a live match', () => {
    // A privacy default, asserted rather than written down (`config.ts`, and the `config-secrets`
    // skill's rule that a default only written down is one that drifts).
    expect(DEFAULT_COACH_CONFIG.tracing).toBe(false);
  });
});

describe('the stimulus', () => {
  beforeEach(() => undefined);

  it('carries the world, the signals and the coach silence, and never an empty signal list', async () => {
    const h = harness();
    h.model.push(declines());
    await bump(h);

    const stimulus = h.model.seen[0];
    expect(stimulus).toBeDefined();
    expect(stimulus?.world).toContain('clock 10:00');
    expect(stimulus?.signals.length).toBeGreaterThan(0);
    expect(stimulus?.secondsSinceSpoke).toBeNull();
    h.coach.dispose();
  });
});

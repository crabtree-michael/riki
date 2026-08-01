/**
 * The engine: the one stateful object in the package, and the only thing that subscribes.
 *
 * It owns four things nothing else can: the latch set, the cooldown clocks, the counters, and the
 * subscription to `WorldModelReader.onVersion`. Everything it calls into is pure, which is why the
 * whole trigger policy is testable without it and why this file has no policy of its own.
 *
 * One tick, in order:
 *
 * ```
 *   version bump ──► intensity.observe(delta)
 *                    detectors  ──► Detection[]
 *                    salience   ──► CoachEvent[]        ──► tape.record() for anything above the floor
 *                    clear latches whose condition went false          ← §5.3, and it happens here
 *                    policy.decide()  ──► speak | refuse(reason)
 *                    speak: arm the latch and the cooldowns, then emit
 * ```
 *
 * **Latches are cleared before the decision, not after.** A latch means "this exact condition has
 * been continuously true since I mentioned it", so the thing that clears it is the condition
 * disappearing from the detectors' output — which is known at exactly this point in the tick and
 * nowhere else.
 *
 * **An admitted trigger arms its cooldowns even if the brief turns out empty** (§5.6). The
 * composition root can render nothing and close the turn `'silent'`; retracting the latch in that
 * case would re-fire the same detection on the very next version bump, render another empty brief,
 * and loop. Consuming the cooldown costs at most one missed moment. The loop costs the product.
 *
 * See docs/design/coaching-trigger-architecture.md §8.
 */

import type { CoachingMemoryReader, EventId } from '@riki/context';
import type { Clock, MonoMs, WorldModelReader, WorldSnapshot } from '@riki/world-model';
import type {
  EventDetector,
  EventEngine,
  EventTape,
  GateContext,
  SalienceScorer,
  TriggerPolicy,
} from './contracts.js';
import type { TriggerConfig } from './config.js';
import { DEFAULT_TRIGGER_CONFIG } from './config.js';
import type {
  CoachEvent,
  CoachEventKind,
  Detection,
  DetectionKey,
  SuppressionReason,
  TriggerCounters,
  TriggerDecision,
  Unsubscribe,
} from './types.js';
import { COACH_EVENT_KINDS, SUPPRESSION_REASONS } from './types.js';
import type { IntensityMonitor } from './intensity.js';
import { createIntensityMonitor } from './intensity.js';
import { createSalienceScorer } from './salience.js';
import { createTriggerPolicy } from './policy.js';
import { createEventTape } from './tape.js';
import { defaultDetectors } from './detect/index.js';
import { notInMatch } from './gates/index.js';

export interface EventEngineDeps {
  readonly world: WorldModelReader;
  /**
   * Injected, because `packages/world-model` deliberately reads no clock — `now` arrives on every
   * call and it is the composition root that owns one. `onVersion` carries a delta and no time, so
   * this is where the tick's `now` comes from, and it is what makes every cooldown assertable
   * without waiting for one.
   */
  readonly clock: Clock;
  /**
   * The novelty gate's only input. Null is allowed and means the gate never refuses: an engine
   * wired before a match ledger exists should be quiet about *repetition*, not quiet about
   * everything (see `GateContext.memory`).
   */
  readonly memory?: CoachingMemoryReader | null;
  readonly config?: TriggerConfig;
  readonly detectors?: readonly EventDetector[];
  readonly scorer?: SalienceScorer;
  readonly policy?: TriggerPolicy;
  readonly tape?: EventTape;
  readonly intensity?: IntensityMonitor;
}

function zeroCounters(): {
  suppressed: Record<SuppressionReason, number>;
  detected: Record<CoachEventKind, number>;
} {
  const suppressed = {} as Record<SuppressionReason, number>;
  for (const reason of SUPPRESSION_REASONS) suppressed[reason] = 0;
  const detected = {} as Record<CoachEventKind, number>;
  for (const kind of COACH_EVENT_KINDS) detected[kind] = 0;
  return { suppressed, detected };
}

export function createEventEngine(deps: EventEngineDeps): EventEngine {
  const cfg = deps.config ?? DEFAULT_TRIGGER_CONFIG;
  const detectors = deps.detectors ?? defaultDetectors();
  const scorer = deps.scorer ?? createSalienceScorer();
  const policy = deps.policy ?? createTriggerPolicy();
  const tape = deps.tape ?? createEventTape();
  const intensity = deps.intensity ?? createIntensityMonitor();
  const memory = deps.memory ?? null;

  const coachListeners = new Set<(event: CoachEvent) => void>();
  const silentListeners = new Set<(reason: SuppressionReason, event: CoachEvent | null) => void>();

  /** Latched keys and the game clock each was latched at, so `latchExpirySeconds` can free them. */
  const latched = new Map<DetectionKey, number>();
  const lastSpokeByKind = new Map<CoachEventKind, MonoMs>();
  let lastSpokeAt: MonoMs | null = null;

  let agentSpeaking = false;
  let playerSpeaking = false;
  let quietMode = false;
  let mutedUntil: MonoMs | null = null;

  let counters = zeroCounters();
  let spoken = 0;
  let unsubscribe: Unsubscribe | null = null;
  let disposed = false;

  function candidatesFrom(world: WorldSnapshot, now: MonoMs): readonly CoachEvent[] {
    const out: CoachEvent[] = [];
    for (const detector of detectors) {
      let produced: readonly Detection[];
      try {
        produced = detector.detect(world, cfg);
      } catch {
        // A detector is specified as total, so this is a bug rather than a condition. It is caught
        // anyway: one detector throwing must not take the other seven — and the whole coaching
        // path — down with it. The kind's detection counter staying at zero is what surfaces it
        // (§5.4), which is the same signal an unwired detector gives.
        produced = [];
      }
      for (const detection of produced) {
        counters.detected[detection.kind] += 1;
        out.push({
          id: detection.kind as EventId,
          kind: detection.kind,
          key: detection.key,
          topic: detection.topic,
          salience: scorer.score(detection, cfg),
          detection,
          at: now,
        });
      }
    }
    return out;
  }

  /**
   * A latch survives only while its condition is still being detected.
   *
   * Also bounded in game time: a condition that has been true for twenty minutes because nothing
   * about the game changed is, eventually, worth mentioning again (§5.3).
   */
  function reconcileLatches(alive: ReadonlySet<DetectionKey>, clock: number | null): void {
    for (const [key, at] of latched) {
      if (!alive.has(key)) {
        latched.delete(key);
        continue;
      }
      if (clock !== null && clock - at >= cfg.latchExpirySeconds) latched.delete(key);
    }
  }

  function tick(now: MonoMs, taken?: WorldSnapshot): TriggerDecision {
    const world = taken ?? deps.world.snapshot(now);
    const candidates = candidatesFrom(world, now);

    const alive = new Set(candidates.map((candidate) => candidate.key));
    reconcileLatches(alive, world.clock);

    const ctx: GateContext = {
      world,
      now,
      clock: world.clock,
      memory,
      cfg,
      intensity: intensity.score(world, cfg),
      agentSpeaking,
      playerSpeaking,
      quietMode,
      mutedUntil,
      lastSpokeAt,
      lastSpokeByKind,
      latched: new Set(latched.keys()),
    };

    // The tape records detections rather than utterances (§6), so it is filled before the gates
    // run and regardless of what they decide. `not_in_match` is the one gate that applies, for the
    // same reason it is gate 1: an entry about an Ability Draft timing is wrong, not just unspoken.
    for (const candidate of candidates) {
      if (candidate.salience < cfg.tapeSalience) continue;
      if (notInMatch.refuses(candidate, ctx)) continue;
      tape.record(candidate);
    }

    const decision = policy.decide(candidates, ctx);

    if (decision.speak) {
      const event = decision.event;
      latched.set(event.key, world.clock ?? 0);
      lastSpokeByKind.set(event.kind, now);
      lastSpokeAt = now;
      spoken += 1;
      for (const listener of coachListeners) listener(event);
      return decision;
    }

    // `event === null` means the detectors produced nothing, which is not a refusal and must not be
    // counted as one.
    if (decision.event !== null) {
      counters.suppressed[decision.reason] += 1;
      for (const listener of silentListeners) listener(decision.reason, decision.event);
    }
    return decision;
  }

  return {
    start(): Unsubscribe {
      if (disposed) return (): void => undefined;
      unsubscribe?.();
      // One snapshot per tick, shared by the intensity fold and the detectors. Two would be two
      // different `now`s inside one decision, which is the shape of a bug that only appears as an
      // age that disagrees with itself across a brief.
      unsubscribe = deps.world.onVersion((_version, delta) => {
        const now = deps.clock.now();
        const world = deps.world.snapshot(now);
        intensity.observe(delta, world);
        tick(now, world);
      });
      return unsubscribe;
    },

    onCoachEvent(listener): Unsubscribe {
      coachListeners.add(listener);
      return () => coachListeners.delete(listener);
    },

    onSuppressed(listener): Unsubscribe {
      silentListeners.add(listener);
      return () => silentListeners.delete(listener);
    },

    tape,

    counters(): TriggerCounters {
      return {
        suppressed: { ...counters.suppressed },
        detected: { ...counters.detected },
        spoken,
      };
    },

    setAgentSpeaking(speaking: boolean): void {
      agentSpeaking = speaking;
    },
    setPlayerSpeaking(speaking: boolean): void {
      playerSpeaking = speaking;
    },
    setQuietMode(on: boolean): void {
      quietMode = on;
    },
    setMuted(until: MonoMs | null): void {
      mutedUntil = until;
    },

    evaluate(now: MonoMs): TriggerDecision {
      return tick(now);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      coachListeners.clear();
      silentListeners.clear();
      latched.clear();
      lastSpokeByKind.clear();
      counters = zeroCounters();
      spoken = 0;
      intensity.reset();
      tape.clear();
    },
  };
}

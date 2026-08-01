/**
 * "Is the player in a fight right now" — the one signal that genuinely needs deltas.
 *
 * Everything else in this package is a pure function of a snapshot (§3.1), and this is the
 * exception that earns its own file: a detector cannot see *how fast* something changed, and how
 * fast the player's health is moving is most of what distinguishes a teamfight from standing in a
 * lane. So the engine folds every `WorldDelta` through this and hands the resulting score to the
 * gates.
 *
 * dota2 §6.4 names the three inputs — *"HP deltas, nearby enemy count, ability usage rate"* — and
 * they are combined with **`Math.max`, not a sum**, because they are three pieces of evidence for
 * one thing rather than three things that add up. Somebody at full health surrounded by four
 * enemies who has cast nothing is in a fight, and so is somebody alone who just lost 60 % of their
 * health to a gank. A sum would need weights; weights are behaviour; behaviour belongs in
 * `config.ts` (§4.5).
 *
 * **The window is game time and the fold is on version bumps.** A pause freezes the match clock, so
 * a pause cannot manufacture calm — the same two-clock rule `packages/world-model`'s staleness
 * policy holds, and for the same reason.
 *
 * See docs/design/coaching-trigger-architecture.md §7.
 */

import type { AbilityState, GameClock, WorldDelta, WorldSnapshot } from '@riki/world-model';
import type { TriggerConfig } from './config.js';
import { SELF_ABILITIES, SELF_HEALTH, clamp01, nearbyEnemies } from './detect/util.js';

export interface IntensityMonitor {
  /** Called for every version bump, before the gates run. Cheap and allocation-light. */
  observe(delta: WorldDelta, world: WorldSnapshot): void;
  /** 0..1. */
  score(world: WorldSnapshot, cfg: TriggerConfig): number;
  reset(): void;
}

interface Sample {
  readonly at: GameClock;
  /** Fraction of max health lost since the previous sample. Never negative — healing is not a fight. */
  readonly hpLost: number;
  readonly casts: number;
}

/**
 * A cast is a `castable` ability that stopped being castable.
 *
 * Reading the cooldown instead would count a cooldown *ticking down* as activity; reading the
 * boolean counts the moment it was used, once, which is the rate dota2 §6.4 asks for.
 */
function castsBetween(
  before: readonly AbilityState[] | undefined,
  after: readonly AbilityState[] | undefined,
): number {
  if (before === undefined || after === undefined) return 0;
  const wasCastable = new Set(before.filter((a) => a.castable).map((a) => a.id));
  return after.filter((a) => !a.castable && wasCastable.has(a.id)).length;
}

export function createIntensityMonitor(): IntensityMonitor {
  let samples: Sample[] = [];

  return {
    observe(delta: WorldDelta, world: WorldSnapshot): void {
      const at = delta.atGameClock ?? world.clock;
      // Before the horn there is no game clock, so there is no window to age samples out of. There
      // is also no fight, which is why dropping the sample is safe rather than merely convenient.
      if (at === null) return;

      let hpLost = 0;
      let casts = 0;

      for (const change of delta.changes) {
        if (change.path === SELF_HEALTH) {
          const before = change.before?.value as { current: number; max: number } | undefined;
          const after = change.after?.value as { current: number; max: number } | undefined;
          if (before !== undefined && after !== undefined && after.max > 0) {
            hpLost = Math.max(0, (before.current - after.current) / after.max);
          }
        } else if (change.path === SELF_ABILITIES) {
          casts = castsBetween(
            change.before?.value as readonly AbilityState[] | undefined,
            change.after?.value as readonly AbilityState[] | undefined,
          );
        }
      }

      if (hpLost > 0 || casts > 0) samples.push({ at, hpLost, casts });
    },

    score(world: WorldSnapshot, cfg: TriggerConfig): number {
      const clock = world.clock;
      if (clock !== null) {
        const cutoff = clock - cfg.intensityWindowSeconds;
        samples = samples.filter((sample) => sample.at >= cutoff);
      }

      let hpLost = 0;
      let casts = 0;
      for (const sample of samples) {
        hpLost += sample.hpLost;
        casts += sample.casts;
      }

      return Math.max(
        clamp01(hpLost / cfg.intensityHpSwing),
        clamp01(nearbyEnemies(world, cfg).length / cfg.intensityNearbyEnemies),
        clamp01(casts / cfg.intensityCasts),
      );
    },

    reset(): void {
      samples = [];
    },
  };
}

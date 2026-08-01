/**
 * Is the Dota client still there?
 *
 * This is the detector behind dota2 §9's *GSI stops mid-game* row, and it works only because the
 * cfg sets `heartbeat` — Valve POSTs at least every 30 s even when nothing changed, so silence
 * means something rather than "nothing happened". Without the heartbeat there would be no way to
 * tell a quiet match from a departed client, which is why that setting is in the cfg at all.
 *
 * **Wall time, always.** This is the archetypal pipeline fact from §5.5: a client that has not
 * POSTed for forty seconds of *paused* game is still gone, so pausing must not stop the clock
 * here the way it stops it for tactical facts.
 */

import type { GsiLiveness, GsiLivenessOptions, MonoMs, SourceHealth } from './contracts.js';

export const DEFAULT_LIVENESS_OPTIONS: GsiLivenessOptions = {
  heartbeatSeconds: 30,
  // ≈1.17 → a 35 s threshold. Tight enough that a dropout is noticed within a creep wave, loose
  // enough that a heartbeat delayed by client load is not reported as a death.
  missMultiplier: 35 / 30,
};

/**
 * `degraded` sits between them because the two failures need different responses: a late
 * heartbeat means keep waiting, a missed one means fall back to CV-only and tell the user. A
 * binary live/down would either cry wolf on the first or be slow on the second.
 */
export function createGsiLiveness(
  opts: GsiLivenessOptions = DEFAULT_LIVENESS_OPTIONS,
): GsiLiveness {
  const heartbeatMs = opts.heartbeatSeconds * 1000;
  const missMs = heartbeatMs * opts.missMultiplier;
  let lastAt: MonoMs | null = null;

  return {
    noteObservation(now: MonoMs): void {
      lastAt = now;
    },

    check(now: MonoMs): { readonly state: SourceHealth['state']; readonly sinceLastMs: number } {
      if (lastAt === null) return { state: 'starting', sinceLastMs: 0 };

      const sinceLastMs = Math.max(0, now - lastAt);
      if (sinceLastMs > missMs) return { state: 'down', sinceLastMs };
      if (sinceLastMs > heartbeatMs) return { state: 'degraded', sinceLastMs };
      return { state: 'live', sinceLastMs };
    },
  };
}

/**
 * Builders for the things a world-model test needs, exported as `@riki/world-model/testing`.
 *
 * Not a fake — the four fakes in REPO_SKELETON §5.2 replace *external* systems, and the world
 * model has none. These just remove the ceremony of hand-writing an `Observation`, so that a
 * fusion test reads as "this payload, this state, this assertion" rather than as six lines of
 * envelope. Shared rather than copied per test file because a builder that drifts between two
 * tests is a test that passes for the wrong reason.
 */

import type { Observation, ObservationKind, SourceId } from '../observation.js';
import type { MonoMs } from '../time.js';
import { asMonoMs } from '../time.js';

export interface ObservationOptions {
  readonly sourceId?: string;
  readonly seq?: number;
  readonly receivedAt?: number;
  readonly v?: number;
}

export function observation<K extends ObservationKind>(
  kind: K,
  payload: unknown,
  opts: ObservationOptions = {},
): Observation<K> {
  return {
    kind,
    sourceId: (opts.sourceId ?? `test:${kind}`) as SourceId,
    seq: opts.seq ?? 0,
    receivedAt: asMonoMs(opts.receivedAt ?? 0),
    payload,
    v: opts.v ?? 1,
  };
}

/** A minimal in-progress GSI POST. Spread over it to vary one component. */
export function gsiPayload(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    provider: { name: 'Dota 2', appid: 570, version: 47, timestamp: 1_754_000_000 },
    map: {
      matchid: '7891234567',
      game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
      clock_time: 600,
      game_time: 690,
      paused: false,
      daytime: true,
    },
    ...overrides,
  };
}

/** One CV batch. `detections` is the only key `readCvDetections` looks at. */
export function cvPayload(detections: readonly Readonly<Record<string, unknown>>[]): unknown {
  return { detections };
}

export function detection(
  overrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { detector: 'minimap', confidence: 0.9, ...overrides };
}

export const T0: MonoMs = asMonoMs(0);

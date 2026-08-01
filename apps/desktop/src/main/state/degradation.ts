/**
 * `DegradationController` — `state-capture-architecture.md` §8.2.
 *
 * The shed order is dota2 §5's, in one place: VLM → scoreboard → top bar → minimap. Minimap is
 * last because it is the highest-value CV signal, which is why the floor is `gsi_only` rather than
 * a level that still has the minimap in it.
 *
 * **Hysteresis is on the way back up only.** A subsystem that oscillates between levels is worse
 * than one that stays down: every level change is a user-visible status string and, for the
 * sidecar, a capture reconfiguration. Going *down* is immediate — the whole point is to stop
 * feeding the model facts a broken source produced — and coming back up waits 10 s (tunable) of
 * continuous health.
 *
 * The controller is a pure fold over health plus a clock. It performs nothing: the level goes to
 * the sidecar through `CapturePort.setDegradationLevel` and to the user-facing status, and both of
 * those are the shell's to do.
 */

import type { DegradationLevel, MonoMs, SubsystemHealth, SourceStatus } from './contracts.js';
import { DEGRADATION_LEVELS } from './contracts.js';

/** §8.2, tunable. Long enough that a sidecar restart does not read as a recovery. */
export const RECOVERY_HYSTERESIS_MS = 10_000;

/** The CV drift monitor's verdict (§5.6). Absent until the sidecar speaks a protocol. */
export type CvDriftStatus = 'ok' | 'drifting' | 'unknown';

export interface DegradationInput {
  readonly sources: readonly SourceStatus[];
  readonly drift: CvDriftStatus;
}

export interface DegradationController {
  evaluate(input: DegradationInput, now: MonoMs): DegradationLevel;
  readonly level: DegradationLevel;
  /** One line, safe to show a user: no token, no path, no chat text. */
  summarise(input: DegradationInput): string;
}

export interface DegradationOptions {
  readonly hysteresisMs?: number;
  /** Which source ids carry CV. Injected because the sidecar's id is the shell's to choose. */
  readonly visionSources?: readonly string[];
  readonly gsiSourceId?: string;
}

/**
 * The level this health *implies*, before hysteresis.
 *
 * Only two inputs can move it today, and that is honest rather than incomplete: the sidecar speaks
 * no protocol yet (REPO_SKELETON.md §10 step 2), so there is no per-region health to shed
 * `no_scoreboard` and `no_topbar` on. Those two levels exist in the type because the shed order is
 * a product decision and belongs in one place — but nothing produces them, and a reader deserves
 * to be told that rather than to discover it.
 */
function impliedLevel(input: DegradationInput, options: DegradationOptions): DegradationLevel {
  const vision = new Set(options.visionSources ?? ['sidecar']);
  // `every` on the empty set is `true`, which is the answer we want: vision turned off in config
  // registers no source at all, and that is `gsi_only` for the same reason a crashed one is.
  const visionDown = input.sources
    .filter((source) => vision.has(source.id))
    .every((source) => source.health.state === 'down');

  if (visionDown) return 'gsi_only';
  if (input.drift === 'drifting') return 'no_vlm';
  return 'full';
}

export function createDegradationController(
  options: DegradationOptions = {},
): DegradationController {
  const hysteresisMs = options.hysteresisMs ?? RECOVERY_HYSTERESIS_MS;
  const gsiSourceId = options.gsiSourceId ?? 'gsi';

  let level: DegradationLevel = 'full';
  /** When the implied level first became better than the current one. Null while it is not. */
  let recoveringSince: MonoMs | null = null;

  return {
    get level(): DegradationLevel {
      return level;
    },

    evaluate(input: DegradationInput, now: MonoMs): DegradationLevel {
      const implied = impliedLevel(input, options);
      const current = DEGRADATION_LEVELS.indexOf(level);
      const next = DEGRADATION_LEVELS.indexOf(implied);

      if (next > current) {
        // Worse. Immediate, and the hysteresis window resets — a source that fails during a
        // recovery has not recovered.
        level = implied;
        recoveringSince = null;
        return level;
      }
      if (next === current) {
        recoveringSince = null;
        return level;
      }

      recoveringSince ??= now;
      if (now - recoveringSince >= hysteresisMs) {
        level = implied;
        recoveringSince = null;
      }
      return level;
    },

    summarise(input: DegradationInput): string {
      const gsi = input.sources.find((source) => source.id === gsiSourceId);
      if (gsi === undefined || gsi.health.state === 'down') {
        return 'No game data. Check that Dota 2 is running and the GSI config is installed.';
      }
      if (gsi.health.state === 'starting') return 'Waiting for Dota 2.';
      switch (level) {
        case 'full':
          return 'Watching the game.';
        case 'no_vlm':
        case 'no_scoreboard':
        case 'no_topbar':
          return 'Watching the game, with reduced screen reading.';
        case 'gsi_only':
          return 'Watching the game through GSI only — no screen reading.';
      }
    },
  };
}

/** The shell's health surface, assembled from the two halves above. */
export function healthOf(
  sources: readonly SourceStatus[],
  controller: DegradationController,
  drift: CvDriftStatus,
  now: MonoMs,
): SubsystemHealth {
  const input: DegradationInput = { sources, drift };
  const level = controller.evaluate(input, now);
  return { sources, level, summary: controller.summarise(input) };
}

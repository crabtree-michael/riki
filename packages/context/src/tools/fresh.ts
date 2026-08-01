/**
 * How a command asks for a fresh look without shortcutting the observation path.
 *
 * `requestRegion` resolves with a **request id, not with detections**. The detections arrive by the
 * normal path and land in the model like everything else, so this waits for the model to change
 * rather than for the sidecar to answer.
 *
 * This is the most important structural decision the component inherits (state-capture §4.3), and
 * it is worth restating why the indirect path is the right one: it means there is exactly one way
 * for a pixel to become something the agent is told, and every stale, low-confidence or
 * contradicted detection is filtered by the same code whether it arrived on a schedule or because
 * the agent asked.
 *
 * See docs/design/agent-command-execution-architecture.md §5.2.
 */

import type { CapturePort, FreshCaptureRequest } from './ports.js';
import type { WorldModelReader, WorldSnapshot } from '../common/ports.js';
import type { CancelSignal, RegionId, ToolOutcome } from './types.js';
import type { Clock } from '../common/types.js';
import type { Timers } from '../common/timers.js';
import { failure, ok } from './failures.js';
import { systemTimers } from '../common/timers.js';

export interface FreshCaptureDeps {
  readonly capture: CapturePort;
  readonly world: WorldModelReader;
  readonly clock: Clock;
  readonly timers?: Timers;
}

export function createFreshCaptureRequest(deps: FreshCaptureDeps): FreshCaptureRequest {
  const timers = deps.timers ?? systemTimers;

  return {
    async request(
      region: RegionId,
      timeoutMs: number,
      signal: CancelSignal,
    ): Promise<ToolOutcome<WorldSnapshot>> {
      return new Promise<ToolOutcome<WorldSnapshot>>((resolve) => {
        let settled = false;
        const cleanups: (() => void)[] = [];

        const finish = (outcome: ToolOutcome<WorldSnapshot>): void => {
          if (settled) return;
          settled = true;
          for (const cleanup of cleanups) cleanup();
          resolve(outcome);
        };

        // "The first version bump containing the region" is spelled as *any change carrying a `cv`
        // fact*, rather than as a region-to-field-path table. A table would be a second place that
        // has to know what the minimap detector writes, and it would be wrong the first time a
        // detector's output moved. What the caller actually needs to know is that a CV pass landed.
        cleanups.push(
          deps.world.onVersion((_version, delta) => {
            const sawCapture = delta.changes.some((change) => change.after?.source === 'cv');
            if (sawCapture) finish(ok(deps.world.snapshot(deps.clock.now())));
          }),
        );

        cleanups.push(
          signal.onCancel((reason) => {
            // The capture request is abandoned, not awaited: whatever it produces will still land
            // in the model by the normal path, and this turn no longer has a question for it.
            finish(failure('cancelled', { detail: reason }));
          }),
        );

        cleanups.push(
          timers.after(timeoutMs, () => {
            finish(failure('timeout', { detail: `no fresh capture for ${String(region)}` }));
          }),
        );

        deps.capture.requestRegion(region, { timeoutMs }).catch((error: unknown) => {
          finish(
            failure('unavailable', {
              detail: `requestRegion(${String(region)}): ${
                error instanceof Error ? error.message : 'rejected'
              }`,
            }),
          );
        });
      });
    },
  };
}

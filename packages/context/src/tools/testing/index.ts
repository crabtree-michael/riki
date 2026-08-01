/**
 * `FakeToolPorts` and friends — the whole component, exercised with no game and no network.
 *
 * REPO_SKELETON.md §5.2 is the rule these serve: no test may require a running Dota 2 client, a
 * real microphone, a GPU, or a live OpenAI session.
 *
 * The shared half — `ManualClock`, `ManualTimers`, `FakeWorldModel`, `observed`, `cvChange`,
 * `FakeCapturePort`, `FakeReferenceData` — moved to `../../testing/index.ts`, which is where every
 * tier's tests import it from (coaching-architecture.md §2.2). What is left here is the part that
 * only a command has: a fresh-capture request, a consent prompt, and the tool telemetry port.
 */

export {
  ManualClock,
  ManualTimers,
  FakeWorldModel,
  FakeCapturePort,
  FakeReferenceData,
  cvChange,
  observed,
} from '../../testing/index.js';
export type { FactSpec, FakeWorldOptions } from '../../testing/index.js';

import type { WorldSnapshot } from '../../common/ports.js';
import type { Clock } from '../../common/types.js';
import type {
  ActivityHandle,
  CancelSignal,
  ConsentDecision,
  ConsentRequest,
  ConsequentialActivity,
  PortId,
  RegionId,
  ToolOutcome,
} from '../types.js';
import type { FreshCaptureRequest, ToolPorts, ToolTelemetry } from '../ports.js';
import {
  FakeCapturePort,
  FakeReferenceData,
  FakeWorldModel,
  ManualClock,
} from '../../testing/index.js';
import { ok } from '../failures.js';

/** Never resolves on its own — a test drives it, or the watchdog does. */
export class FakeFreshCapture implements FreshCaptureRequest {
  readonly calls: RegionId[] = [];
  outcome: ((snapshot: WorldSnapshot) => ToolOutcome<WorldSnapshot>) | null = null;

  constructor(
    private readonly world: FakeWorldModel,
    private readonly clock: Clock,
  ) {}

  request(region: RegionId): Promise<ToolOutcome<WorldSnapshot>> {
    this.calls.push(region);
    const snapshot = this.world.snapshot(this.clock.now());
    return Promise.resolve(this.outcome?.(snapshot) ?? ok(snapshot));
  }
}

/**
 * Records every prompt and every indicator, which is what the consent tests assert on.
 *
 * The indicator being observable separately from the prompt is the point: dota2 §7 asks for an
 * unmistakable indicator *while* capture happens, and a fake that conflated the two would let a
 * bug that ends the indicator early pass every test.
 */
export class RecordingConsentPort {
  readonly prompts: ConsentRequest[] = [];
  readonly activities: ConsequentialActivity[] = [];
  /** Non-null while an activity is up. The Acting indicator is exactly this being non-null. */
  active: ConsequentialActivity | null = null;
  endedCount = 0;
  decision: ConsentDecision = 'granted';

  request(req: ConsentRequest, signal: CancelSignal): Promise<ConsentDecision> {
    this.prompts.push(req);
    if (signal.cancelled) return Promise.resolve('expired');
    return Promise.resolve(this.decision);
  }

  begin(activity: ConsequentialActivity): ActivityHandle {
    this.activities.push(activity);
    this.active = activity;
    return {
      end: () => {
        this.endedCount += 1;
        this.active = null;
      },
    };
  }
}

export class RecordingTelemetry implements ToolTelemetry {
  readonly calls: { name: string; status: string; elapsedMs: number; tokens: number }[] = [];
  readonly ports: { port: PortId; outcome: 'ok' | 'fail'; elapsedMs: number }[] = [];

  noteCall(name: string, status: string, elapsedMs: number, tokens: number): void {
    this.calls.push({ name, status, elapsedMs, tokens });
  }

  notePort(port: PortId, outcome: 'ok' | 'fail', elapsedMs: number): void {
    this.ports.push({ port, outcome, elapsedMs });
  }
}

// -----------------------------------------------------------------------------------------------
// The set
// -----------------------------------------------------------------------------------------------

export interface FakeToolPorts extends ToolPorts {
  readonly world: FakeWorldModel;
  readonly capture: FakeCapturePort;
  readonly fresh: FakeFreshCapture;
  readonly reference: FakeReferenceData;
  readonly consent: RecordingConsentPort;
  readonly clock: ManualClock;
  readonly telemetry: RecordingTelemetry;
}

export function createFakeToolPorts(
  options: {
    readonly world?: ConstructorParameters<typeof FakeWorldModel>[0];
    readonly clock?: ManualClock;
  } = {},
): FakeToolPorts {
  const clock = options.clock ?? new ManualClock();
  const world = new FakeWorldModel(options.world ?? {});
  return {
    world,
    capture: new FakeCapturePort(),
    fresh: new FakeFreshCapture(world, clock),
    reference: new FakeReferenceData(),
    consent: new RecordingConsentPort(),
    clock,
    telemetry: new RecordingTelemetry(),
  };
}

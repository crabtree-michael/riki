/**
 * The four ports — the game API abstraction.
 *
 * A command handler may touch nothing else: no HTTP client, no sidecar, no file, no clock of its
 * own. The game's several very different channels — a local HTTP listener, a Rust sidecar over
 * stdio, a rotating log file, a cached web API — are already unified by the time they reach here,
 * into one read interface plus three command interfaces.
 *
 * See docs/design/agent-command-execution-architecture.md §5.
 *
 * `WorldModelReader`, `WorldSnapshot` and `WorldDelta` moved to `../common/ports.ts`, because
 * Tiers 1 and 2 read the world model too (context-and-memory-architecture.md §8.1), and
 * `CapturePort` and `ReferenceDataPort` followed them there — the first because
 * state-capture-architecture.md §4.3 owns it, the second because preamble enrichment consumes it
 * (coaching-architecture.md §2.2). They are re-exported here so §5.1 of the command architecture
 * still names them in this file.
 */

export type {
  BuildBenchmark,
  CapturePort,
  Fetched,
  ItemInfo,
  MatchupNote,
  ReferenceDataPort,
  RequestId,
  WorldDelta,
  WorldModelReader,
  WorldSnapshot,
} from '../common/ports.js';
export type { Clock } from '../common/types.js';

import type { Clock } from '../common/types.js';
import type {
  CapturePort,
  ReferenceDataPort,
  WorldModelReader,
  WorldSnapshot,
} from '../common/ports.js';
import type {
  ActivityHandle,
  CancelSignal,
  ConsentDecision,
  ConsentRequest,
  ConsequentialActivity,
  PortId,
  RegionId,
  ToolOutcome,
} from './types.js';

// -----------------------------------------------------------------------------------------------
// §5.2 — the only outbound command channel
// -----------------------------------------------------------------------------------------------

/** How `get_minimap_summary` waits for a fresh pass without shortcutting the observation path. */
export interface FreshCaptureRequest {
  /** Resolves on the first version bump containing the region, or fails on timeout. */
  request(
    region: RegionId,
    timeoutMs: number,
    signal: CancelSignal,
  ): Promise<ToolOutcome<WorldSnapshot>>;
}

// -----------------------------------------------------------------------------------------------
// §5.4 — consent, and the indicator
// -----------------------------------------------------------------------------------------------

/**
 * `begin()` is separate from `request()` because dota2 §7 asks for an unmistakable indicator while
 * capture is happening, and a prompt that disappears on `Y` is not one. The overlay's Acting state
 * is the indicator (overlay-architecture.md §4.4), driven by the activity handle, so it cannot
 * outlive or under-live the capture.
 */
export interface ConsentPort {
  request(req: ConsentRequest, signal: CancelSignal): Promise<ConsentDecision>;
  begin(activity: ConsequentialActivity): ActivityHandle;
}

// -----------------------------------------------------------------------------------------------
// Telemetry (the clock is `Clock`, re-exported from ../common/types.js at the top of this file)
// -----------------------------------------------------------------------------------------------

/**
 * `console.*` is confined to `packages/telemetry` (REPO_SKELETON.md §6.2), which is why this is a
 * port rather than a logger. `detail` strings may pass through it; `output` strings are content.
 */
export interface ToolTelemetry {
  /** `name` is a plain string, not a `ToolName`: an unknown-tool call is worth counting too. */
  noteCall(name: string, status: string, elapsedMs: number, tokens: number): void;
  notePort(port: PortId, outcome: 'ok' | 'fail', elapsedMs: number): void;
}

/** What a handler is given, and the whole of what it can reach. */
export interface ToolPorts {
  readonly world: WorldModelReader;
  readonly capture: CapturePort;
  readonly fresh: FreshCaptureRequest;
  readonly reference: ReferenceDataPort;
  readonly consent: ConsentPort;
  readonly clock: Clock;
  readonly telemetry: ToolTelemetry;
}

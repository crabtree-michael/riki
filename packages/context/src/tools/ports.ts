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
 * ⚠ Transitional. `WorldModelReader`, `WorldSnapshot`, `CapturePort` and `WorldDelta` are owned by
 * state-capture-architecture.md §7.1 and §4.3; `packages/world-model` is step 4 and still empty, so
 * the ones this component consumes are declared structurally here. When that package lands, this
 * file imports them and deletes its copies — the structural declarations are a consequence of
 * writing this first, not a design position.
 */

import type {
  ActivityHandle,
  CancelSignal,
  ConsentDecision,
  ConsentRequest,
  ConsequentialActivity,
  GameClock,
  HeroId,
  ItemId,
  MonoMs,
  PortId,
  RegionId,
  ToolOutcome,
  Unsubscribe,
} from './types.js';

// -----------------------------------------------------------------------------------------------
// §5.1 — every game fact, one way in
// -----------------------------------------------------------------------------------------------

/** Opaque here. `packages/world-model` owns its shape; this component only reads through it. */
export interface WorldSnapshot {
  readonly version: number;
  readonly now: MonoMs;
  readonly clock: GameClock | null;
}

export interface WorldDelta {
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * state-capture-architecture.md §7.1, unchanged.
 *
 * No command reads a source. Not GSI, not the log tailer, not the sidecar. Everything a handler can
 * know has been through fusion, precedence, the confidence gate and ageing exactly once — which is
 * the only way those guarantees actually reach the agent.
 */
export interface WorldModelReader {
  snapshot(now: MonoMs): WorldSnapshot;
  onVersion(listener: (version: number, delta: WorldDelta) => void): Unsubscribe;
  history(since: GameClock): readonly WorldDelta[];
}

// -----------------------------------------------------------------------------------------------
// §5.2 — the only outbound command channel
// -----------------------------------------------------------------------------------------------

/**
 * state-capture-architecture.md §4.3. `requestRegion` resolves with a request id, **not** with
 * detections: the detections arrive by the normal observation path and land in the model like
 * everything else. A command that pulled results straight back would be a second way for a CV fact
 * to reach the agent — one with no precedence, no confidence gate and no age.
 */
export interface CapturePort {
  requestRegion(region: RegionId, opts: { timeoutMs: number }): Promise<RequestId>;
}

export type RequestId = string & { readonly __brand: 'RequestId' };

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
// §5.3 — the data that is not about this match
// -----------------------------------------------------------------------------------------------

/** Patch-keyed and disk-cached. The same port Tier 1 preamble assembly uses for draft enrichment. */
export interface ReferenceDataPort {
  item(id: ItemId): Promise<ToolOutcome<ItemInfo>>;
  matchup(a: HeroId, b: HeroId): Promise<ToolOutcome<MatchupNote>>;
  benchmark(hero: HeroId, at: GameClock): Promise<ToolOutcome<BuildBenchmark>>;
}

/** Shapes are illustrative — dota2 §2.4 treats external data as best-effort and it will change. */
export interface ItemInfo {
  readonly id: ItemId;
  readonly cost: number;
  readonly components: readonly ItemId[];
}

export interface MatchupNote {
  readonly summary: string;
  readonly patch: string;
}

export interface BuildBenchmark {
  readonly atClock: GameClock;
  readonly expectedNetWorth: number;
  readonly expectedLevel: number;
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
// Clock and telemetry
// -----------------------------------------------------------------------------------------------

/** Injected, so every deadline and rate window is deterministic in a Tier 1 test. */
export interface Clock {
  now(): MonoMs;
}

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

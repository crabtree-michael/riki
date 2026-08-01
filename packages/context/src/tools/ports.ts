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
 * ⚠ Transitional. `CapturePort` is owned by state-capture-architecture.md §4.3 and
 * `packages/world-model` is step 4 and still empty, so what this component consumes is declared
 * structurally — a consequence of writing this first, not a design position.
 *
 * `WorldModelReader`, `WorldSnapshot` and `WorldDelta` moved to `../common/ports.ts`, because
 * Tiers 1 and 2 read the world model too (context-and-memory-architecture.md §8.1). They are
 * re-exported here so §5.1 of the command architecture still names them in this file.
 */

export type { WorldDelta, WorldModelReader, WorldSnapshot } from '../common/ports.js';
export type { Clock } from '../common/types.js';

import type { Clock } from '../common/types.js';
import type { WorldModelReader, WorldSnapshot } from '../common/ports.js';
import type { HeroLibraryQuery, HeroLibraryResult } from '../reference/hero-library/types.js';
import type {
  ActivityHandle,
  CancelSignal,
  ConsentDecision,
  ConsentRequest,
  ConsequentialActivity,
  GameClock,
  HeroId,
  ItemId,
  PortId,
  RegionId,
  ToolOutcome,
} from './types.js';

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
  /**
   * The hero library (hero-library.md). Static content today, served by
   * `createStaticHeroLibrary()` — the first part of this port with a real implementation.
   *
   * It takes the *query* rather than the hero, and returns notes already ranked. That is what puts
   * the search behind the seam: a later live implementation can rank server-side instead of
   * shipping a hero's whole entry across to be filtered here.
   */
  heroLibrary(query: HeroLibraryQuery): Promise<ToolOutcome<HeroLibraryResult>>;
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

/**
 * `FakeToolPorts` and friends — the whole component, exercised with no game and no network.
 *
 * REPO_SKELETON.md §5.2 is the rule these serve: no test may require a running Dota 2 client, a
 * real microphone, a GPU, or a live OpenAI session. Everything Tier 3 touches is a port, and all
 * four of them are satisfied here, which is what makes §13's claim — that almost all of this
 * component is Tier 1 testable today — true rather than aspirational.
 *
 * They are also not test-only scaffolding: `pnpm dev:replay` is meant to drive the real pipeline
 * against these, which is what keeps a fake from quietly drifting from the thing it stands in for
 * (§5.5).
 */

import type {
  FieldChange,
  FieldPath,
  Roster,
  WorldDelta,
  WorldModelReader,
  WorldSnapshot,
} from '../../common/ports.js';
import type {
  Clock,
  GameClock,
  MonoMs,
  Observed,
  Provenance,
  Staleness,
  Unsubscribe,
} from '../../common/types.js';
import type {
  ActivityHandle,
  CancelSignal,
  ConsentDecision,
  ConsentRequest,
  ConsequentialActivity,
  HeroId,
  ItemId,
  PortId,
  RegionId,
  ToolOutcome,
} from '../types.js';
import type {
  BuildBenchmark,
  CapturePort,
  FreshCaptureRequest,
  ItemInfo,
  MatchupNote,
  ReferenceDataPort,
  RequestId,
  ToolPorts,
  ToolTelemetry,
} from '../ports.js';
import type { Timers } from '../timers.js';
import { failure, ok } from '../failures.js';

// -----------------------------------------------------------------------------------------------
// Time
// -----------------------------------------------------------------------------------------------

/** A clock that only moves when a test moves it. Every deadline assertion depends on this. */
export class ManualClock implements Clock {
  #now: MonoMs;

  constructor(start = 0) {
    this.#now = start as MonoMs;
  }

  now(): MonoMs {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now = (this.#now + ms) as MonoMs;
  }

  set(ms: number): void {
    this.#now = ms as MonoMs;
  }
}

interface PendingTimer {
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/**
 * Timers a test fires by hand.
 *
 * Paired with `ManualClock` rather than replacing it: the watchdog asks "what time is it" *and*
 * "wake me later", and a test that controlled only one of the two would assert against a deadline
 * the code disagreed about.
 */
export class ManualTimers implements Timers {
  readonly #pending = new Set<PendingTimer>();
  #now = 0;

  after(ms: number, fn: () => void): () => void {
    const timer: PendingTimer = { at: this.#now + Math.max(0, ms), fn, cancelled: false };
    this.#pending.add(timer);
    return () => {
      timer.cancelled = true;
      this.#pending.delete(timer);
    };
  }

  /** Advance and fire everything due, oldest first. Also advances a clock if one is bound. */
  advance(ms: number, clock?: ManualClock): void {
    this.#now += ms;
    clock?.advance(ms);
    const due = [...this.#pending].filter((t) => t.at <= this.#now).sort((a, b) => a.at - b.at);
    for (const timer of due) {
      this.#pending.delete(timer);
      if (!timer.cancelled) timer.fn();
    }
  }

  get pending(): number {
    return this.#pending.size;
  }
}

// -----------------------------------------------------------------------------------------------
// The world model
// -----------------------------------------------------------------------------------------------

export interface FactSpec {
  readonly value: unknown;
  readonly staleness?: Staleness;
  readonly ageMs?: number;
  readonly confidence?: number;
  readonly source?: Provenance;
}

/** `observed('bot', {source:'cv', confidence: 0.91, ageMs: 4000})` — the shape tests write most. */
export function observed<T>(value: T, spec: Omit<FactSpec, 'value'> = {}): Observed<T> {
  return {
    value,
    staleness: spec.staleness ?? 'fresh',
    ageMs: spec.ageMs ?? 0,
    confidence: spec.confidence ?? 1,
    source: spec.source ?? 'gsi',
  };
}

export interface FakeWorldOptions {
  readonly clock?: GameClock | null;
  readonly roster?: Partial<Roster>;
  readonly facts?: Readonly<Record<string, Observed<unknown>>>;
  readonly unseen?: readonly HeroId[];
  readonly history?: readonly WorldDelta[];
}

export class FakeWorldModel implements WorldModelReader {
  #version = 1;
  #clock: GameClock | null;
  #roster: Roster;
  #facts: Map<string, Observed<unknown>>;
  #unseen: readonly HeroId[];
  #history: WorldDelta[];
  readonly #listeners = new Set<(version: number, delta: WorldDelta) => void>();

  constructor(options: FakeWorldOptions = {}) {
    this.#clock = options.clock ?? (600 as GameClock);
    this.#roster = {
      self: options.roster?.self ?? ('nevermore' as HeroId),
      allies: options.roster?.allies ?? [],
      enemies: options.roster?.enemies ?? (['pudge', 'zuus'] as HeroId[]),
    };
    this.#facts = new Map(Object.entries(options.facts ?? {}));
    this.#unseen = options.unseen ?? [];
    this.#history = [...(options.history ?? [])];
  }

  snapshot(now: MonoMs): WorldSnapshot {
    const facts = this.#facts;
    const roster = this.#roster;
    const unseen = this.#unseen;
    return {
      version: this.#version,
      now,
      clock: this.#clock,
      get: <T>(path: FieldPath) => facts.get(String(path)) as Observed<T> | undefined,
      roster: () => roster,
      unseenFor: () => unseen,
    };
  }

  onVersion(listener: (version: number, delta: WorldDelta) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  history(): readonly WorldDelta[] {
    return this.#history;
  }

  // -- test controls ----------------------------------------------------------------------------

  set(path: string, value: Observed<unknown>): void {
    this.#facts.set(path, value);
  }

  setRoster(roster: Partial<Roster>): void {
    this.#roster = { ...this.#roster, ...roster };
  }

  setClock(clock: GameClock | null): void {
    this.#clock = clock;
  }

  setHistory(deltas: readonly WorldDelta[]): void {
    this.#history = [...deltas];
  }

  /** Publish a version bump. `changes` decides whether a `FreshCaptureRequest` is satisfied. */
  bump(changes: readonly FieldChange[] = []): void {
    this.#version += 1;
    const delta: WorldDelta = {
      fromVersion: this.#version - 1,
      toVersion: this.#version,
      atGameClock: this.#clock,
      changes,
    };
    for (const listener of [...this.#listeners]) listener(this.#version, delta);
  }
}

/** A CV-sourced change, which is what `FreshCaptureRequest` watches for. */
export function cvChange(path: string, value: unknown, confidence = 0.9): FieldChange {
  return {
    path: path as FieldPath,
    before: undefined,
    after: observed(value, { source: 'cv', confidence }),
  };
}

// -----------------------------------------------------------------------------------------------
// The outbound ports
// -----------------------------------------------------------------------------------------------

export class FakeCapturePort implements CapturePort {
  readonly requests: RegionId[] = [];
  /** Set to make `requestRegion` reject, which is the "sidecar is gone" case. */
  failWith: Error | null = null;

  requestRegion(region: RegionId): Promise<RequestId> {
    this.requests.push(region);
    return this.failWith === null
      ? Promise.resolve(`req-${String(this.requests.length)}` as RequestId)
      : Promise.reject(this.failWith);
  }
}

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

export class FakeReferenceData implements ReferenceDataPort {
  items = new Map<string, ItemInfo>();
  matchups = new Map<string, MatchupNote>();
  benchmarks: BuildBenchmark | null = null;
  /** Every lookup answers `unavailable` — the "reference API is down" row of §10. */
  down = false;

  item(id: ItemId): Promise<ToolOutcome<ItemInfo>> {
    if (this.down) return Promise.resolve(failure('unavailable', { detail: 'fake: down' }));
    const found = this.items.get(String(id));
    return Promise.resolve(
      found === undefined
        ? failure('unavailable', { detail: `fake: no ${String(id)}` })
        : ok(found),
    );
  }

  matchup(a: HeroId, b: HeroId): Promise<ToolOutcome<MatchupNote>> {
    if (this.down) return Promise.resolve(failure('unavailable', { detail: 'fake: down' }));
    const found = this.matchups.get(`${String(a)}|${String(b)}`);
    return Promise.resolve(
      found === undefined ? failure('unavailable', { detail: 'fake: no matchup' }) : ok(found),
    );
  }

  benchmark(): Promise<ToolOutcome<BuildBenchmark>> {
    if (this.down || this.benchmarks === null) {
      return Promise.resolve(failure('unavailable', { detail: 'fake: down' }));
    }
    return Promise.resolve(ok(this.benchmarks));
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
  options: { readonly world?: FakeWorldOptions; readonly clock?: ManualClock } = {},
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

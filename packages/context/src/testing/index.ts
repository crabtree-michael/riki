/**
 * The fakes that make almost all of this package Tier 1 — REPO_SKELETON.md §5.2.
 *
 * > No test may require a running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * Everything this package touches is a port, and every one of them is satisfied here.
 * `FakeWorldModel` is a `Map` of field paths, which is what makes the whole suite — including the
 * privacy egress tests, the ones that cannot be walked back once they have failed in the field —
 * run in a bare vitest process.
 *
 * These are not test-only scaffolding: `pnpm dev:replay` drives the real renderer against them,
 * which is what keeps a fake from quietly drifting from the thing it stands in for (§5.5).
 */

import type {
  FieldChange,
  FieldPath,
  RequestId,
  Roster,
  WorldDelta,
  WorldModelReader,
  WorldSnapshot,
} from '../common/ports.js';
import type {
  Clock,
  GameClock,
  HeroId,
  MonoMs,
  Observed,
  Provenance,
  RegionId,
  Staleness,
  Unsubscribe,
} from '../common/types.js';
import type { Timers } from '../common/timers.js';
import type { TokenCounter } from '../render/types.js';

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
 * Paired with `ManualClock` rather than replacing it: a caller with a deadline asks "what time is
 * it" *and* "wake me later", and a test that controlled only one of the two would assert against a
 * deadline the code disagreed about.
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
    // `??` would be wrong here: `clock: null` is the pre-horn case a test asks for on purpose, and
    // coalescing it to a default makes the one snapshot that must render without a clock untestable.
    this.#clock = options.clock === undefined ? (600 as GameClock) : options.clock;
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

  /**
   * The gap next to `setRoster`: change the draft and the unseen list has to move with it, or the
   * fake reports heroes as unseen who are not in the game.
   */
  setUnseen(unseen: readonly HeroId[]): void {
    this.#unseen = unseen;
  }

  setHistory(deltas: readonly WorldDelta[]): void {
    this.#history = [...deltas];
  }

  /** Publish a version bump, so a test can assert what a subscriber does with a delta. */
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

/** A CV-sourced change, for a test that needs a delta rather than a state. */
export function cvChange(path: string, value: unknown, confidence = 0.9): FieldChange {
  return {
    path: path as FieldPath,
    before: undefined,
    after: observed(value, { source: 'cv', confidence }),
  };
}

// -----------------------------------------------------------------------------------------------
// The one outbound port
// -----------------------------------------------------------------------------------------------

export class FakeCapturePort {
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

/**
 * A counter that returns exactly what a test tells it to.
 *
 * Every budget assertion in this component is really an assertion about *what happens at a
 * threshold*, and finding the string that costs exactly 401 tokens under the real estimator is
 * research, not a test. `fixed()` makes the threshold the input.
 */
export function fixedCounter(perCall: number): TokenCounter {
  return { count: (text) => (text === '' ? 0 : perCall) };
}

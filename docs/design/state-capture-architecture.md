# State Capture — Module & Class Architecture

**Status:** Draft / design proposal
**Companion to:** [`dota2-state-capture-design.md`](dota2-state-capture-design.md). That document decides
*what* Riki observes and *why*; this one decides *how the code is shaped* — module boundaries, class
responsibilities, method signatures, and the seams between them.
**Scope:** `packages/gsi`, `packages/log-tail`, `packages/world-model`, the observation half of
`packages/protocol`, and the read interface that `packages/context` and `packages/events` consume.
**Out of scope:** The internals of the Rust sidecar (`crates/riki-*` — see the `vision-sidecar` skill),
the snapshot *text format* (`packages/context`, dota2 §6.2), salience scoring (`packages/events`,
dota2 §6.4), and the voice pipeline.

## 0. Assumptions

Stated up front, house style, and flagged where load-bearing:

1. **⚑ The world model is single-writer.** Every mutation goes through one `apply()` call on one
   object owned by the Electron main process. Every reader gets an immutable snapshot. If this turns
   out to be wrong — because fusion needs to move to a worker thread — most of §5 changes.
2. **⚑ Fusion is a pure function.** `packages/world-model` performs no I/O, reads no clock, and opens
   no socket. Time arrives as a parameter. This is what makes Tier 1 unit tests possible at all, and
   it is the constraint most likely to be eroded by a convenient shortcut.
3. **Sources and the model do not know about each other.** They meet at a protocol type. A source
   cannot import `@riki/world-model`; the model cannot import `@riki/gsi`. §2.3 gives the lint rule.
4. **This document specifies interfaces, not implementations.** The contracts it describes, and now
   the behaviour behind them, have landed for `packages/gsi`, `packages/log-tail` and
   `packages/world-model` (§12). Treat a disagreement with the signatures here as a reason to amend
   this file and the contracts together, not to diverge silently — **§13 is that amendment for the
   step-4 implementation**, and the next one should extend it the same way.
5. Numbers marked *(tunable)* are starting points to be measured, not decisions. Numbers not so
   marked come from the companion design doc or from REPO_SKELETON and should not be changed here.

---

## 1. The shape of the problem

Three sources produce facts at three very different rates, with three very different levels of
trust, and one consumer that reads at a fourth rate entirely:

| Producer | Rate | Trust | Failure mode |
|---|---|---|---|
| GSI | 2–8 Hz, irregular, push | Authoritative | Goes silent; never lies |
| Console log | Event-driven, push | Authoritative for what it reports | File rotates out from under you |
| Vision sidecar | 1–5 Hz, scheduled | Probabilistic | Lies confidently after a resolution change |
| The agent | ~1 read/minute | — | Drowns in detail |

Almost every design decision below follows from one observation: **the hard part is not collecting
the facts, it is keeping the difference between them intact all the way to the agent.** A pipeline
that flattens a 0.55-confidence minimap blob and a GSI health value into the same `number` has
thrown away the only thing that stops Riki from confidently getting someone killed.

So the architecture carries provenance, confidence, and age in the *type*, from the moment a fact is
observed to the moment it is rendered — and makes it impossible to construct a fact without them.

---

## 2. Module map

### 2.1 The graph

```
                    ┌──────────────────────┐
                    │  packages/protocol   │  zod schemas: Observation, Fact,
                    │  (the contract)      │  CvFact, SidecarMessage, versioned
                    └──────────┬───────────┘
                               │ everyone depends on this; it depends on nothing
        ┌──────────────┬───────┴────────┬──────────────────┐
        │              │                │                  │
┌───────▼──────┐ ┌─────▼───────┐ ┌──────▼────────┐  ┌──────▼─────────┐
│ packages/gsi │ │ packages/   │ │ crates/       │  │ packages/      │
│              │ │ log-tail    │ │ riki-vision   │  │ config         │
│ HTTP · auth  │ │ tail · parse│ │ (sidecar,     │  │ (injected      │
│ liveness     │ │ rotation    │ │  own process) │  │  settings)     │
└───────┬──────┘ └─────┬───────┘ └──────┬────────┘  └────────────────┘
        │              │                │
        │   Observation<K> — the only thing a source emits
        │              │                │
        └──────────────┴────────┬───────┘
                                │
                    ┌───────────▼────────────────────────────┐
                    │  apps/desktop/src/main/state           │
                    │  COMPOSITION ROOT (§8)                 │
                    │  SourceSupervisor · ObservationBus     │
                    │  DegradationController · ports         │
                    └───────────┬────────────────────────────┘
                                │ store.apply(observation, now)
                    ┌───────────▼────────────────────────────┐
                    │  packages/world-model                  │
                    │  WorldModelStore  (single writer)      │
                    │   ├ FusionReducer   (pure)             │
                    │   ├ PrecedencePolicy · ConfidenceGate  │
                    │   ├ StalenessPolicy                    │
                    │   ├ DerivedRegistry (pure, lazy)       │
                    │   └ RingHistory · DeltaComputer        │
                    └───────┬───────────────────────┬────────┘
                            │ WorldSnapshot         │ WorldDelta
                            │ (immutable, versioned)│
              ┌─────────────▼──────┐      ┌─────────▼──────────┐
              │ packages/context   │      │ packages/events    │
              │ Tier 1/2/3 (§7)    │      │ salience, gates    │
              └────────────────────┘      └────────────────────┘
```

Two properties of that graph are worth stating explicitly, because they are what make the design
modular rather than merely layered:

- **It is a DAG with a single join point.** Sources fan in to exactly one writer; readers fan out
  from exactly one snapshot. There is no path by which a source observes another source, and no path
  by which a reader writes.
- **The arrows are types, not calls.** A source hands over an `Observation` and forgets about it. The
  store hands over a `WorldSnapshot` and forgets about it. Nothing in the diagram holds a reference to
  a live object owned by another module, which is why every box can be tested with the boxes on
  either side replaced by a fixture.

### 2.2 Responsibilities, one line each

| Module | Owns | Explicitly does not own |
|---|---|---|
| `packages/protocol` | The wire shape of every fact and message; version stamping | Any behaviour |
| `packages/gsi` | Listening, authenticating, parsing, GSI liveness, match-session identity | Deciding what a fact means |
| `packages/log-tail` | Following the file across rotation, line→event parsing, privacy tagging | Chat semantics, egress policy |
| `packages/world-model` | Fusion, precedence, confidence gating, ageing, derived state, history | I/O, clocks, scheduling, the LLM |
| `packages/context` | Preamble, snapshot text, tool surface, token budget | Fusion, deciding to speak |
| `packages/events` | Deltas → typed events, salience, cooldowns, interrupt gates | Rendering, fusion |
| `apps/desktop/src/main/state` | Wiring, lifecycle, supervision, backpressure, degradation | Any domain logic |

### 2.3 The boundary lints this design needs

REPO_SKELETON §6.2 already forbids `world-model → realtime`. This architecture adds two rules,
which landed in `eslint.config.js` **with the implementation**, not before (a rule with nothing to
catch cannot be verified, and the `workspace` skill is emphatic that an unverified boundary rule is
decoration):

```js
// in boundaries/element-types, alongside the existing world-model → realtime rule
{
  from: [['package', { name: 'world-model' }]],
  disallow: [
    ['package', { name: 'gsi' }],
    ['package', { name: 'log-tail' }],
    ['package', { name: 'context' }],
    ['package', { name: 'events' }],
  ],
  message:
    'packages/world-model may not import a source or a reader — sources and the model meet at a protocol type, never at each other (ADR-0014).',
},
{
  from: [['package', { name: 'gsi' }], ['package', { name: 'log-tail' }]],
  disallow: [['package', { name: 'world-model' }]],
  message: 'A source emits Observations; it does not know what consumes them.',
},
```

Verify each by adding the dependency to the importing package's `package.json`, writing a file that
violates the rule, running `pnpm exec eslint` on it, confirming the error, then reverting both.

> **Corrected during implementation.** This section originally placed both rules in
> `boundaries/external`, on the reasoning that workspace packages are imported by name. They are in
> **`element-types`** instead. Once the importing package actually declares the dependency — the
> only situation the rule needs to catch — `eslint-import-resolver-typescript` resolves
> `@riki/gsi` to `packages/gsi/**`, boundaries matches it as a `package` **element**, and the
> `external` rule stays silent. A rule written only in `external` passes on a real violation. The
> `workspace` skill records the same correction; `boundaries/external` is for genuine node_modules
> packages such as `electron` and `openai`.

---

## 3. Core data structures

These live in `packages/protocol`. Everything else in this document is built on them, so they are
specified first and in the most detail.

### 3.1 Time

Two clocks, deliberately not interchangeable. Conflating them is the single most likely bug in this
subsystem — GSI's update rate is unreliable, so anything derived from wall time and anything derived
from match time have to be told apart by the compiler.

```ts
/** Local monotonic milliseconds. Never wall-clock: NTP steps and DST must not move a fact's age. */
export type MonoMs = number & { readonly __brand: 'MonoMs' };

/** Dota's `map.clock_time`, in seconds. Negative before the horn. Frozen while paused. */
export type GameClock = number & { readonly __brand: 'GameClock' };

export interface Clock {
  now(): MonoMs;
}
```

`Clock` is injected everywhere. `packages/world-model` never calls `performance.now()`; it receives
`now` as an argument. That is assumption ⚑2, made mechanical.

### 3.2 The fact envelope

The central type. Every value in the world model is wrapped in it:

```ts
export type FactSource = 'gsi' | 'log' | 'cv' | 'api' | 'derived';

/** 0–1. Exactly 1.0 for gsi/log/api; a detector match score for cv. */
export type Confidence = number & { readonly __brand: 'Confidence' };

export interface Fact<T> {
  readonly value: T;
  readonly source: FactSource;
  readonly confidence: Confidence;
  /** When the underlying observation was made, local monotonic. */
  readonly observedAt: MonoMs;
  /** Match clock at observation, or null if the match had no clock yet (draft, loading). */
  readonly atGameClock: GameClock | null;
  /** Opaque per-source detail for debugging: detector id, log line number, GSI component. */
  readonly origin?: string;
}
```

**Facts are constructed only through factories.** The interface is not exported for direct object
construction; these are:

```ts
export function gsiFact<T>(value: T, at: Timestamps, origin?: string): Fact<T>;
export function logFact<T>(value: T, at: Timestamps, origin?: string): Fact<T>;
export function cvFact<T>(value: T, at: Timestamps, confidence: Confidence, detector: string): Fact<T>;
export function apiFact<T>(value: T, at: Timestamps, origin?: string): Fact<T>;
export function derivedFact<T>(value: T, at: Timestamps, from: readonly Fact<unknown>[]): Fact<T>;

export interface Timestamps {
  readonly observedAt: MonoMs;
  readonly atGameClock: GameClock | null;
}
```

Three things fall out of this that are worth the ceremony:

- `cvFact` is the only factory that takes a confidence, and it *requires* one. REPO_SKELETON §4 says
  a CV fact constructible without a confidence score will eventually be rendered as though it were
  certain; this makes that unconstructible rather than merely discouraged.
- `derivedFact` takes its inputs, so a derived value inherits the *minimum* confidence and the
  *oldest* `observedAt` of what it was computed from. "Gold until Diffusal" derived from a stale
  net-worth estimate is itself stale, and says so.
- **Age is not stored.** It is computed at read time from `observedAt` and the `now` passed in. A
  stored age is an age that is wrong by the time anyone reads it.

**Only fusion calls the factories.** A source emits a *payload*; the reducer decides what facts that
payload implies and stamps them. This fell out of scaffolding §4 — `packages/gsi` and
`packages/log-tail` turned out to need no part of this module, which is a good sign rather than an
accident: it is what lets a source stay unaware that a world model exists at all (ADR-0014), and it
means provenance is stamped in exactly one place instead of at every source that might forget.

### 3.3 Observations — what a source emits

```ts
export type ObservationKind = 'gsi.payload' | 'log.event' | 'cv.detections' | 'api.enrichment';

export interface Observation<K extends ObservationKind = ObservationKind> {
  readonly kind: K;
  readonly sourceId: SourceId;
  /** Per-source monotone counter. A gap means dropped observations; a decrease means reorder. */
  readonly seq: number;
  readonly receivedAt: MonoMs;
  readonly payload: ObservationPayload[K];
  /** protocol version, checked at the process boundary (REPO_SKELETON §4). */
  readonly v: number;
}
```

An observation is **a batch of candidate facts, not a state**. The reducer decides what, if anything,
it changes. A source that thinks it knows the world state has taken on a job that belongs to fusion.

### 3.4 The source interface

The extensibility seam. Adding a fourth live source means implementing this and nothing else:

```ts
export interface ObservationSource<K extends ObservationKind> {
  readonly id: SourceId;
  readonly kind: K;

  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (o: Observation<K>) => void): Unsubscribe;
  /** Cheap, synchronous, called by the supervisor on a timer. Must not do I/O. */
  health(now: MonoMs): SourceHealth;
}

export interface SourceHealth {
  readonly state: 'starting' | 'live' | 'degraded' | 'down';
  readonly lastObservationAt: MonoMs | null;
  /** Human-readable, shown to the user on degradation. Never contains a token or chat text. */
  readonly reason?: string;
}
```

### 3.5 World state

The illustrative shape in dota2 §4 becomes concrete. Every leaf is a `Fact<T>`, and optionality is
meaningful: `undefined` is *never observed*, which is not the same as *observed to be absent*.

```ts
export interface WorldState {
  readonly version: number;
  readonly meta: MatchMeta;                          // match id, patch, phase, paused, clock
  readonly self: SelfState;                          // all Fact<T>, all source 'gsi'
  readonly allies: ReadonlyMap<HeroId, AllyState>;
  readonly enemies: ReadonlyMap<HeroId, EnemyState>;
  readonly map: MapState;
  readonly chat: RingHistory<ChatLine>;
  readonly history: RingHistory<WorldDelta>;
}

export interface EnemyState {
  readonly hero: Fact<HeroId>;
  readonly level?: Fact<number>;
  readonly alive?: Fact<boolean>;
  readonly respawnIn?: Fact<Seconds>;
  readonly position?: Fact<MapPosition>;             // cv only
  readonly itemsSeen: readonly Fact<ItemId>[];
  readonly lastSeenAt?: Fact<MapPosition>;           // survives expiry of `position`
}
```

`position` expiring into `lastSeenAt` rather than vanishing is what lets the snapshot render
`unseen >20s: ws, zeus` instead of silently omitting two heroes — dota2 §6.2 calls that distinction
out, and it only survives if the data structure has somewhere to put it.

---

## 4. Sources

### 4.1 `packages/gsi`

```
packages/gsi/src/
  index.ts              public surface
  server.ts             GsiServer
  auth.ts               GsiAuthenticator
  parse.ts              GsiPayloadParser
  liveness.ts           GsiLiveness
  session.ts            MatchSessionTracker
  clock.ts              GameClockEstimator
  testing/index.ts      FakeGsiSource
```

```ts
export class GsiServer implements ObservationSource<'gsi.payload'> {
  constructor(opts: {
    readonly port: number;                 // from @riki/config; default 53101
    readonly token: string;                // per-install secret written by tools/setup-gsi-cfg
    readonly clock: Clock;
    readonly maxBodyBytes: number;         // 1 MiB (tunable) — reject rather than buffer
  });

  start(): Promise<void>;                  // binds 127.0.0.1 only; never 0.0.0.0
  stop(): Promise<void>;
  subscribe(listener: (o: Observation<'gsi.payload'>) => void): Unsubscribe;
  health(now: MonoMs): SourceHealth;
  /** Actual bound port, for the case where 0 was passed in tests. */
  readonly address: { port: number } | null;
}
```

Binding to loopback is a security property, not a default: the endpoint accepts unauthenticated-shaped
POSTs from anything that can reach it, and the token is the only other line of defence.

```ts
export class GsiAuthenticator {
  constructor(expected: string);
  /** Constant-time. Returns a verdict, never throws, and never logs or returns the token. */
  verify(presented: string | undefined): 'ok' | 'missing' | 'mismatch';
}

export class GsiPayloadParser {
  /**
   * Validates against the protocol schema and normalises. Unknown fields pass through
   * rather than failing: Valve adds components between patches, and a strict parser turns a
   * patch day into a total outage.
   */
  parse(raw: unknown, at: Timestamps): ParseResult<GsiPayload>;
}
```

Three parsing details that are easy to get wrong and expensive to discover late:

- **`previously` and `added` are discarded.** Dota's GSI includes both alongside the current values.
  The current values are the truth; the delta blocks are a convenience we do not need because fusion
  computes its own deltas, and consuming them means maintaining two notions of "what changed".
  *Verify against a live capture before relying on this.*
- **A POST is a partial state.** Only enabled components appear, and a component may be absent from a
  given POST. Absent means *unchanged*, not *cleared* — the reducer must not null a field because a
  POST omitted it.
- **`clock_time` is negative pre-horn** and does not advance while `map.paused` is true.

```ts
export class GsiLiveness {
  constructor(opts: { heartbeatSeconds: number; missMultiplier: number; clock: Clock });
  noteObservation(now: MonoMs): void;
  check(now: MonoMs): { state: SourceHealth['state']; sinceLastMs: number };
}
```

`heartbeat` is 30 s in the cfg, so a miss threshold of 35 s (`missMultiplier` ≈ 1.17) distinguishes
"nothing changed" from "the client is gone". This is the detector behind dota2 §9's *GSI stops
mid-game* row, and it is the reason `heartbeat` is configured at all.

```ts
export class MatchSessionTracker {
  /** Returns lifecycle transitions, not state: the caller reacts to edges. */
  observe(payload: GsiPayload, at: Timestamps): readonly MatchLifecycleEvent[];
}

export type MatchLifecycleEvent =
  | { type: 'match_started'; matchId: MatchId; heroes: DraftSummary }
  | { type: 'phase_changed'; from: MatchPhase; to: MatchPhase }
  | { type: 'paused' } | { type: 'resumed' }
  | { type: 'clock_discontinuity'; delta: Seconds }   // reconnect, or a new match on the same id
  | { type: 'match_ended'; matchId: MatchId; winner: Team | null };
```

`match_started` is what triggers Tier 1 preamble assembly and external API enrichment (§7.1), and
`clock_discontinuity` is what triggers a resync rather than a slow drift into wrongness.

```ts
export class GameClockEstimator {
  update(clock: GameClock, at: MonoMs, paused: boolean): void;
  /** Interpolates between GSI updates. Returns null before the first update. */
  estimate(now: MonoMs): GameClock | null;
}
```

Interpolation exists so that a fact observed between GSI POSTs still gets a game clock. It advances
at 1 s/s while unpaused and freezes while paused, and it is corrected — never smoothed — on the next
real update. **Never** infer elapsed time from update count; the rate is unreliable by design.

### 4.2 `packages/log-tail`

```
packages/log-tail/src/
  index.ts
  tailer.ts             ConsoleLogTailer  — follow, rotation, truncation, partial lines
  matchers/index.ts     LineMatcher registry
  matchers/chat.ts      matchers/killfeed.ts  matchers/ping.ts
  privacy.ts            PrivacyClass tagging
```

```ts
export class ConsoleLogTailer implements ObservationSource<'log.event'> {
  constructor(opts: {
    readonly path: string;
    readonly matchers: readonly LineMatcher[];
    readonly clock: Clock;
    readonly pollMs: number;             // 250 (tunable) — fs.watch is unreliable across platforms
  });
  start(): Promise<void>;  stop(): Promise<void>;
  subscribe(listener: (o: Observation<'log.event'>) => void): Unsubscribe;
  health(now: MonoMs): SourceHealth;
}
```

The tailer's whole job is the boring part: **the file you opened is not the file being written to ten
minutes later.** It must handle (a) rotation — the path now points at a new inode; (b) truncation —
same inode, size went backwards; (c) a partial trailing line, which must be buffered rather than
parsed; (d) starting mid-match, which means seeking to the end rather than replaying history.
Each of these is a Tier 1 test against a temp file, and each has a fixture in `fixtures/console-log/`.

```ts
export interface LineMatcher {
  readonly id: string;
  /** Pure. Returns null for a line it does not recognise — the common case, so keep it cheap. */
  match(line: string, at: Timestamps): LogEvent | null;
}
```

Adding kill-feed parsing later is a new file in `matchers/` and one array entry. That is the point of
the registry: console log format is outside our control and will change under us, so the unit of
breakage should be one small file with its own fixtures.

**Privacy is applied at the source, not at the sink.** Chat lines carry other people's words
(dota2 §7), so the tagging happens where the data is created, before anything can forget:

```ts
export type PrivacyClass = 'public' | 'sensitive';
export interface ChatLine { readonly text: string; readonly privacy: 'sensitive'; /* ... */ }
```

`packages/telemetry` redacts on `privacy: 'sensitive'`, and `packages/context` refuses to render such
a field into the snapshot unless the corresponding config flag is on. Two independent gates, because
this is the failure that cannot be walked back once it has left the machine.

### 4.3 The sidecar boundary

The Rust sidecar is a separate process and a separate area (`vision-sidecar` skill). From this
subsystem's side it is just another `ObservationSource`, wrapped by an adapter that lives in the
composition root:

```ts
// apps/desktop/src/main/state/sidecar-source.ts
export class SidecarObservationSource implements ObservationSource<'cv.detections'> { /* ... */ }
```

Two things cross that boundary, and they are asymmetric:

- **Out of the sidecar:** `Observation<'cv.detections'>`, push, on the sidecar's own schedule. Every
  detection carries `confidence`, `observedAt`, and a detector id — non-optional in the schema, per
  REPO_SKELETON §4.
- **Into the sidecar:** commands, not queries — `setRegionSchedule`, `recalibrate`,
  `requestRegion(region)`, `setDegradationLevel`. Modelled as a separate port because the world model
  must never initiate I/O (assumption ⚑2):

```ts
export interface CapturePort {
  setRegionSchedule(schedule: RegionSchedule): Promise<void>;
  requestRegion(region: RegionId, opts: { timeoutMs: number }): Promise<RequestId>;
  recalibrate(): Promise<void>;
  setDegradationLevel(level: DegradationLevel): Promise<void>;
}
```

`requestRegion` resolves with a request id, **not** with detections. The detections arrive by the
normal observation path and land in the model like everything else. A tool that pulled results
straight back to its caller would create a second way for a CV fact to reach the agent — one that
bypasses precedence, confidence gating, and ageing. §7.2 shows how the tool surface waits for the
result without that shortcut.

---

## 5. `packages/world-model`

The heart of it. Everything here is pure except `WorldModelStore`, which is a thin mutable shell
around pure functions.

```
packages/world-model/src/
  index.ts
  store.ts              WorldModelStore          — the only mutable thing
  state.ts              WorldState, empty(), field paths
  fusion/reducer.ts     FusionReducer            — pure
  fusion/precedence.ts  PrecedencePolicy
  fusion/confidence.ts  ConfidenceGate
  fusion/staleness.ts   StalenessPolicy, AgePolicy
  derived/registry.ts   DerivedRegistry
  derived/rules/*.ts    one file per derived fact
  history/ring.ts       RingHistory<T>
  history/delta.ts      DeltaComputer, WorldDelta
  snapshot.ts           WorldSnapshot            — immutable read view
```

### 5.1 The store

```ts
export class WorldModelStore implements WorldModelReader {
  constructor(opts: {
    readonly precedence?: PrecedencePolicy;
    readonly confidence?: ConfidenceGate;
    readonly staleness?: StalenessPolicy;
    readonly derived?: DerivedRegistry;
    readonly historyWindowSeconds?: number;      // 300, per dota2 §4
  });

  /** The single writer. Synchronous, allocation-light, target < 1 ms. */
  apply(o: Observation, now: MonoMs): ApplyResult;

  /** Immutable, cheap, safe to hand to anything. Derived state is computed lazily on first read. */
  snapshot(now: MonoMs): WorldSnapshot;

  readonly version: number;
  onVersion(listener: (version: number, delta: WorldDelta) => void): Unsubscribe;

  /** Reconnect / new match. Keeps nothing but the session identity. */
  reset(reason: ResetReason, now: MonoMs): void;
  /** Pause: stop game-time ageing without discarding anything (§5.5). */
  setPaused(paused: boolean, now: MonoMs): void;
}

export interface ApplyResult {
  readonly changed: boolean;
  readonly version: number;
  readonly accepted: number;
  readonly rejected: readonly RejectionReason[];   // kept for telemetry; silent drops hide bugs
}
```

`rejected` is not decoration. "CV facts stopped landing three patches ago" is exactly the kind of
failure that presents as *nothing*, and a counter is the cheapest possible detector for it.

### 5.2 Fusion

```ts
export type FusionReducer = (
  state: WorldState,
  o: Observation,
  now: MonoMs,
  policies: FusionPolicies,
) => FusionOutcome;

export interface FusionOutcome {
  readonly state: WorldState;                      // === input state when nothing changed
  readonly rejections: readonly RejectionReason[];
}
```

No `this`, no clock, no I/O. A fusion test is: construct a state, apply an observation, assert the
next state. Milliseconds, no fixtures required beyond the ones already in `fixtures/gsi/`.

### 5.3 Precedence

The rule from the `game-state` skill — *GSI beats CV; CV never overwrites fresh GSI* — needs two
things to become code: a definition of "fresh", and the recognition that **precedence is per field
class, not global**.

```ts
export class PrecedencePolicy {
  canWrite(field: FieldPath, incoming: Fact<unknown>, existing: Fact<unknown> | undefined,
           now: MonoMs): PrecedenceVerdict;
}
export type PrecedenceVerdict =
  | { write: true }
  | { write: false; reason: 'lower_rank' | 'gsi_shadow' | 'older' | 'lower_confidence' };
```

| Field class | Authoritative | May fill gaps | Never writes | Note |
|---|---|---|---|---|
| `self.*` | `gsi` | — | `cv` | CV of own HUD feeds the drift monitor (§5.6), never the model |
| `map.buildings.*` | `gsi` | — | `cv` | The `buildings` component covers both teams; minimap CV is redundant |
| `meta.*` | `gsi` | — | all | Match identity and clock have exactly one honest source |
| `*.hero` (`roster`) | `gsi` (draft) | `cv` (top bar) | — | **Added during implementation.** The `draft` component is populated only during the draft phase, so an app started mid-match never sees it and the top bar has to be able to name a hero GSI never did. Folding this into `meta` would make a CV-only start nameless; folding it into `enemy_progress` would let a 0.6 top-bar guess overwrite a draft-confirmed pick |
| `enemies[].position` | `cv` | — | — | GSI cannot see it; §8.2 fairness allows only what is on the minimap |
| `enemies[].alive/respawn` | `log` (kill feed) | `cv` (top bar) | — | The log gives an exact instant; CV gives a rounded timer |
| `enemies[].level/items` | `cv` | — | — | Top bar and scoreboard |
| `chat` | `log` | `cv` (OCR) | — | OCR only when the log path is unavailable — an availability gate, not confidence |
| `derived.*` | `derived` | — | all | Recomputed, never written from outside |

Three `map.*` fields have no row of their own because their policy is already stated: `map.daytime`
is `meta` (GSI-only, nothing else may write it), `map.roshanState` is `enemy_liveness` (kill feed
exact, top bar rounded — the same two sources in the same order), and `map.wardsSeen` is
`enemy_position` (CV-only, §8.2 allows only what the minimap renders). Duplicating the rows would
add a place for them to disagree.

**"Never writes" is rank 0, not "lowest priority."** A rank-0 source is refused unconditionally,
however stale the field is and however long the authoritative source has been quiet. That is the
whole difference between `self.health` — where a disagreeing CV reading is a calibration signal
(§5.6) and never a fact — and `enemies[].alive`, where CV *should* write once the kill feed has
gone quiet because otherwise nobody would.

Rules applied in order:

1. **Rank.** A lower-ranked source never overwrites a higher-ranked one for that field class.
2. **GSI shadow.** Even where a lower-ranked source *may* fill a gap, it may not write while the
   authoritative source has produced a value within `gsiShadowWindowMs` = 2000 *(tunable)*. Once GSI
   has been quiet longer than that, a CV fact may land — tagged `cv`, so it renders with its
   confidence and its age rather than as fact.
3. **Recency.** Within a source, an older observation never overwrites a newer one. This is what
   makes out-of-order delivery harmless instead of corrupting.
4. **Confidence.** Within `cv`, a lower-confidence detection does not overwrite a higher-confidence
   one that is still fresh. A 0.55 blob does not get to erase a 0.91 sighting from a second ago.
   "Still fresh" needs a number for the same reason "quiet" does, so `PrecedenceOptions` gained a
   second field during implementation — `confidenceWindowMs`, 2000 *(tunable)*. Without it the rule
   either never fires or lets a confident sighting from four minutes ago block every update forever.

### 5.4 The confidence gate

```ts
export class ConfidenceGate {
  constructor(thresholds: ReadonlyMap<DetectorId, Confidence>);
  admit(fact: Fact<unknown>, detector: DetectorId): boolean;
}
```

Below threshold the fact is **dropped, not softened**. The alternative — admitting it with low
confidence and letting the renderer hedge — puts the decision in the layer least able to make it, and
dota2 §4 rule 3 is unambiguous that silence beats a confident hallucination in a voice product.

### 5.5 Staleness — and the two-clock rule

```ts
export type AgeBasis = 'wall' | 'game';
export interface AgePolicy {
  readonly basis: AgeBasis;
  readonly freshMs: number; readonly agingMs: number; readonly expiredMs: number;
}

export class StalenessPolicy {
  ageOf(fact: Fact<unknown>, now: MonoMs, clock: GameClock | null): Age;
  classify(field: FieldPath, fact: Fact<unknown>, now: MonoMs, clock: GameClock | null): Staleness;
}
export type Staleness = 'fresh' | 'aging' | 'stale' | 'expired';
```

The non-obvious part, and the reason `AgeBasis` exists at all:

> **Tactical facts age in game time. Pipeline facts age in wall time.**

While the game is paused, nothing on the map moves — an enemy position from "10 seconds ago" is still
exactly true, and ageing it out would make Riki forget the map during every pause. But GSI liveness
must keep ageing in wall time, because a client that has stopped POSTing for 40 s of paused game is
still gone. One `basis` field, and both behave correctly through a pause without special-casing.

Expiry is a transition, not a deletion: an expired `position` becomes `lastSeenAt` (§3.5), and the
snapshot renders "last seen mid ~12 s ago" — a hypothesis, presented as one.

### 5.6 The CV drift monitor

The one place CV output touches `self.*`, and it does not write to the model:

```ts
export class CvDriftMonitor {
  observe(cvValue: number, gsiValue: number, at: MonoMs): void;
  /** Rolling agreement over a window. Falling agreement means calibration has drifted. */
  status(now: MonoMs): { agreement: number; verdict: 'ok' | 'suspect' | 'broken' };
}
```

CV reads the player's own HUD, where GSI already gives ground truth, so disagreement is a free and
continuous calibration check. `broken` is the detector for dota2 §9's *CV confidence collapse* and
*resolution/HUD scale change* rows: the `DegradationController` (§8.2) suppresses all CV facts and
requests recalibration. Getting this signal for free is the reason to keep reading a region we
otherwise have no need for.

### 5.7 Derived state

```ts
export interface DerivedRule<T> {
  readonly id: DerivedId;
  readonly dependsOn: readonly FieldPath[];
  /** Pure. Returns null when inputs are missing or too stale to answer honestly. */
  compute(state: WorldState, now: MonoMs, clock: GameClock | null): Fact<T> | null;
}

export class DerivedRegistry {
  register<T>(rule: DerivedRule<T>): void;
  /** Lazy and memoised per state version. Only recomputes rules whose dependencies changed. */
  resolve(state: WorldState, now: MonoMs, clock: GameClock | null): DerivedView;
}
```

Laziness rather than scheduling is a deliberate simplification of dota2 §5's *"recompute on change,
coalesced to 10 Hz"*. If derived state is computed on first read of a snapshot and cached against the
version, then a burst of eight GSI updates between two agent turns costs one computation instead of
eight, with no timer, no coalescing window, and no possibility of reading a half-updated view. The
coalescing target is met as a consequence of the structure rather than enforced by a scheduler.

Returning `null` when inputs are too stale is what keeps derived state honest. "You can afford
buyback" computed from 40-second-old gold is worse than no answer.

One rule per file, each with its own unit test: gold-until-item, buyback affordability, Roshan
window, rune timings, stack timing, power-spike proximity, net-worth lead, unseen-enemy set.

### 5.8 History and deltas

```ts
export class RingHistory<T> {
  constructor(opts: { windowSeconds: number; maxEntries: number });
  push(entry: T, at: GameClock | null, now: MonoMs): void;
  since(clock: GameClock): readonly T[];
  last(n: number): readonly T[];
}

export class DeltaComputer {
  compute(prev: WorldState, next: WorldState): WorldDelta;
}

export interface WorldDelta {
  readonly fromVersion: number; readonly toVersion: number;
  readonly atGameClock: GameClock | null;
  readonly changes: readonly FieldChange[];
}
```

Bounded by both time and entry count: a five-minute window is unbounded in a pathological match, and
this process runs for hours next to a game that needs the memory.

`WorldDelta` is the entire input to `packages/events`. That module never sees an `Observation`, which
is what stops "did the agent already mention this" logic from creeping into fusion.

---

## 6. Real-time update handling

The four mechanisms that make an irregular 2–8 Hz push stream behave.

### 6.1 The path of one GSI POST

1. **t+0** — `GsiServer` receives the POST. `GsiAuthenticator.verify()`. A 403 for a bad token is
   returned immediately and counted; the body is never parsed.
2. `GsiPayloadParser.parse()` → `GsiPayload`. Parse failure is counted and dropped, never thrown at
   the HTTP layer; Dota does not care and will keep POSTing.
3. `GameClockEstimator.update()`; `MatchSessionTracker.observe()` emits any lifecycle edges.
4. An `Observation<'gsi.payload'>` is published with `seq` and `receivedAt`. **The HTTP response is
   sent here, before fusion runs** — the client is not made to wait on our processing.
5. `ObservationBus` delivers to the composition root, which calls `store.apply(o, clock.now())`.
6. `FusionReducer` folds candidate facts through precedence, gate, and staleness. Version increments
   only if something actually changed.
7. `onVersion` fires. `packages/events` computes salience from the delta; `packages/context` does
   nothing at all until a turn begins.

Budget, from REPO_SKELETON §5.4: **steps 1–6 under 10 ms**, and `snapshot()` → rendered text under
5 ms. Both are asserted in Tier 4 against a replayed match, not measured by hand.

### 6.2 Ordering

`seq` per source detects gaps and reorder; neither is treated as fatal. Precedence rule 3 (recency)
means an out-of-order observation is rejected per-field rather than dropped wholesale, so a late CV
batch still contributes the fields it is newest for. Sequence gaps are counted — a rising gap rate on
the sidecar link is a real signal and the only cheap way to see it.

### 6.3 Backpressure

```ts
export class ObservationBus {
  publish(o: Observation): void;
  subscribe(fn: (o: Observation) => void): Unsubscribe;
  stats(): { depth: number; dropped: ReadonlyMap<ObservationKind, number> };
}
```

Bounded per kind, with policy by kind: **GSI and log observations are never dropped** (low rate,
authoritative, and dropping one loses information nothing else carries). CV batches drop *oldest
first* — a stale minimap frame is worthless the moment a newer one exists, so shedding the old one is
strictly better than queueing it. Drops are counted, never silent.

### 6.4 Pause, reconnect, and match change

| Trigger | Detected by | Response |
|---|---|---|
| `map.paused` | `MatchSessionTracker` | `store.setPaused(true)` — game-time ageing freezes (§5.5) |
| Clock jumps backwards or > 5 s forward | `GameClockEstimator` | `clock_discontinuity` → mark all CV facts stale, keep GSI |
| `match_id` changes | `MatchSessionTracker` | `store.reset('new_match')`, rebuild Tier 1 preamble |
| Heartbeat missed > 35 s | `GsiLiveness` | Degrade to CV-only, tell the user, keep retrying |
| Sidecar exits | `SourceSupervisor` | Restart with backoff; suppress CV facts meanwhile |

The cross-cutting rule from dota2 §9 — *degrade loudly to the developer, quietly to the user, and
never silently into wrongness* — is implemented as: every one of these paths marks facts stale rather
than deleting them, increments a counter, and hands the user-facing string to the shell. There is no
path in this design that discards data and stays quiet about it.

---

## 7. Integration with context management

This is the seam the whole architecture exists to protect: state arrives at 8 Hz, the agent speaks
once a minute, and the two must not be coupled (dota2 §1).

### 7.1 The read interface

`packages/context` and `packages/events` see exactly this, and nothing else:

```ts
export interface WorldModelReader {
  snapshot(now: MonoMs): WorldSnapshot;
  onVersion(listener: (version: number, delta: WorldDelta) => void): Unsubscribe;
  history(since: GameClock): readonly WorldDelta[];
}
```

`WorldSnapshot` is a frozen view with accessors that make age impossible to ignore:

```ts
export interface WorldSnapshot {
  readonly version: number;
  readonly now: MonoMs;
  readonly clock: GameClock | null;
  readonly state: WorldState;
  readonly derived: DerivedView;

  /** Returns the fact with its staleness classification — you cannot read the value alone. */
  get<T>(path: FieldPath): { fact: Fact<T>; staleness: Staleness } | undefined;
  enemies(): readonly { hero: HeroId; state: EnemyState; staleness: Staleness }[];
  unseenFor(seconds: number): readonly HeroId[];
}
```

`get()` returning the staleness alongside the fact rather than a bare `T` is the design decision that
carries §3.2's premise into the renderer. It is mildly annoying at every call site, which is the
intended effect: the annoyance is the reminder that a bare value is not what the agent should be told.

Three tiers, three cadences, all pull-based:

- **Tier 1 (preamble)** — assembled once on `match_started`, from the draft plus external API
  enrichment. Immutable for the match, so it sits in the prompt cache prefix.
- **Tier 2 (snapshot)** — `snapshot()` is called *at turn boundaries and on high-salience events*,
  not on version change. This is the decoupling: seven of eight GSI updates are never rendered.
- **Tier 3 (tools)** — §7.2.

External API enrichment (dota2 §2.4) has no owner in REPO_SKELETON §2.2's map. This design places it
in `packages/context` as part of Tier 1 assembly, since that is its only consumer, with a
patch-version-keyed disk cache. Flagged in §10 as a boundary that may want its own package if
on-demand lookups grow past preamble use.

### 7.2 Tools that need fresh data

`get_minimap_summary()` and `read_screen(region)` need a *new* observation, not the current model.
The flow keeps every CV fact on the one path:

```
context tool ──► CapturePort.requestRegion(region)  ──► sidecar
                                                          │
                                       Observation<'cv'>  ▼
context awaits ◄── onVersion ◄── store.apply() ◄── ObservationBus
       │
       └─► snapshot() and render — or time out and answer "I can't see that right now"
```

```ts
export class FreshCaptureRequest {
  constructor(port: CapturePort, reader: WorldModelReader);
  /** Resolves on the first version bump containing the region, or rejects on timeout. */
  request(region: RegionId, timeoutMs: number): Promise<WorldSnapshot>;
}
```

The timeout branch is not an error path, it is a feature: *"I can't see that right now"* is an
acceptable answer and a stale confident one is not.

### 7.3 What the model must never know

`packages/world-model` exports no type mentioning tokens, prompts, turns, or messages. The existing
lint rule blocks `world-model → realtime`; §2.3 extends it to `context` and `events`. The test that
this holds is behavioural rather than structural: **the world model should be usable by a replay tool
that renders a match timeline to a terminal with no LLM anywhere.** If that becomes awkward to write,
something has leaked.

---

## 8. Composition root

Nothing above constructs anything. Wiring lives in `apps/desktop/src/main/state/`, which contains no
domain logic — it exists so that everything else can be built and tested without Electron.

```
apps/desktop/src/main/state/
  index.ts                  buildStateSubsystem(config, clock) — the only exported function
  supervisor.ts             SourceSupervisor
  bus.ts                    ObservationBus wiring
  sidecar-source.ts         SidecarObservationSource + CapturePort impl
  degradation.ts            DegradationController
```

```ts
export function buildStateSubsystem(config: RikiConfig, clock: Clock): StateSubsystem;

export interface StateSubsystem {
  readonly reader: WorldModelReader;
  readonly capture: CapturePort;
  readonly health: () => SubsystemHealth;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### 8.1 Supervision

```ts
export class SourceSupervisor {
  add(source: ObservationSource<ObservationKind>, policy: RestartPolicy): void;
  start(): Promise<void>; stop(): Promise<void>;
  /** Polled on a timer; aggregates SourceHealth and drives the DegradationController. */
  health(now: MonoMs): SubsystemHealth;
}
```

Restart with exponential backoff and a cap. The sidecar is the one that will actually crash
(dota2 §3 requires it to crash without taking the agent down); GSI and log-tail restart on
configuration change.

### 8.2 Degradation

```ts
export class DegradationController {
  evaluate(health: SubsystemHealth, drift: CvDriftStatus, now: MonoMs): DegradationLevel;
}
export type DegradationLevel = 'full' | 'no_vlm' | 'no_scoreboard' | 'no_topbar' | 'gsi_only';
```

The shed order is dota2 §5's, in one place: VLM → scoreboard → top bar → minimap, minimap last
because it is the highest-value CV signal. The level goes to the sidecar via
`CapturePort.setDegradationLevel` and to the user-facing status. Hysteresis on the way back up
*(tunable: 10 s)* — a subsystem that oscillates between levels is worse than one that stays down.

---

## 9. Extensibility

What each kind of change actually costs. If a change here is expensive, the boundaries are wrong.

**Add a live source** (e.g. a replay parser) — implement `ObservationSource`, add an
`ObservationKind` and payload schema to `packages/protocol`, add a reducer arm and a precedence row,
register it in the supervisor. No existing module changes behaviour. Four files, one of them the
protocol (a coordination event — say so in the commit message).

**Add a derived fact** — one file in `world-model/src/derived/rules/`, one `register()` call, one
unit test. Nothing else. This is deliberately the cheapest change in the system, because dota2 §4
puts most of the coaching value here.

**Add a CV region** — sidecar side (`crates/`), plus a detector id, a confidence threshold, a
precedence row, and a reducer arm. The TypeScript side does not learn a new concept.

**Add a log event type** — one matcher file plus a fixture line. The registry means a console-log
format change breaks one small file, which is the right blast radius for a format we do not control.

**Add an agent tool** — entirely within `packages/context`. If a new tool seems to need a change in
`world-model`, that is the signal the model is being asked to know it is feeding an LLM.

**Change the snapshot format** — `packages/context` and a golden diff. Zero fusion changes. This is
the point of the whole separation: the format is the interface to the LLM and it will change often.

---

## 10. Testing seams

Per REPO_SKELETON §5.3. The design is arranged so that the highest-value logic sits in the cheapest
tier.

| Unit | Tier | Test looks like |
|---|---|---|
| `PrecedencePolicy` | 1 | Table-driven over the §5.3 matrix, including the GSI shadow window |
| `StalenessPolicy` | 1 | Ages across a simulated pause; asserts the two-clock rule |
| `DerivedRule` (each) | 1 | Inputs → expected value; and inputs-too-stale → `null` |
| `FusionReducer` | 1 | State + observation → state. No fixtures, no clock |
| `RingHistory` | 1 | Eviction by both window and entry cap |
| `GsiPayloadParser` | 1 | `fixtures/gsi/` lines, plus an unknown-component line that must not throw |
| `GsiAuthenticator` | 1 | Missing / wrong / correct; assert the token never appears in output |
| `ConsoleLogTailer` | 1 | Temp file: rotate, truncate, partial line, start-mid-file |
| `GameClockEstimator` | 1 | Interpolation, freeze-on-pause, correction on discontinuity |
| `WorldSnapshot` | 2 | Golden, via `packages/context` — format changes read as a diff |
| Observation schemas | 3 | TS ↔ Rust round-trip over `fixtures/protocol/` |
| Full path | 4 | `FakeGsiSource` + `FakeVisionSidecar` replay; latency budgets; dota2 §9 table |

The two fakes named in REPO_SKELETON §5.2 are sufficient for everything above: `FakeGsiSource`
implements `ObservationSource<'gsi.payload'>` and `FakeVisionSidecar` implements the `CapturePort`
plus `ObservationSource<'cv.detections'>` pair. Because they satisfy the same interfaces as the real
sources, `pnpm dev:replay` drives the actual subsystem rather than a parallel test-only path.

---

## 11. What this design does not decide

1. **The `WorldState` field set is illustrative, not final.** §3.5 fixes the *shape* — every leaf a
   `Fact<T>`, optionality meaning never-observed. The field list will grow during implementation.
2. **Whether fusion eventually needs its own thread.** Assumption ⚑1 says no, on the basis that
   `apply()` is sub-millisecond over a 2–8 Hz stream. If the CV rate rises, revisit — the pure
   reducer makes the move mechanical, which is part of why it is pure.
3. **Ownership of external API enrichment** (§7.1). Placed in `packages/context`; may want its own
   package if on-demand lookups grow beyond preamble assembly. REPO_SKELETON §2.2 does not cover it.
4. **Every number marked *(tunable)*** — the GSI shadow window most of all, since it decides how
   quickly CV is allowed to speak for a silent GSI.
5. **Whether `previously`/`added` in the GSI payload are safely ignorable** (§4.1). Needs a live
   capture to confirm; it is the assumption in this document most likely to be wrong.
6. **The confidence thresholds per detector** — they depend on the minimap CV spike, which dota2
   §10.3 names as the load-bearing assumption of the entire vision layer and which has not been run.

Items 5 and 6 are the two that should be resolved by measurement before `packages/world-model` is
considered done, rather than by argument.

---

## 12. Where the contracts live

~~Declaration-only TypeScript, landed with this document. No behaviour: every `declare`d function is
a signature waiting for REPO_SKELETON §10 step 4.~~

**Implemented (REPO_SKELETON §10 step 4).** Every `declare` below is now a function with a test.
`packages/gsi`, `packages/log-tail` and `packages/world-model` carry behaviour; the composition
root (§8), the `CapturePort` (§4.3) and `FreshCaptureRequest` (§7.2) are still unbuilt, because
they belong to `apps/desktop` and to the wiring pass. §13 records where the implementation
disagreed with this document.

| This document | File |
|---|---|
| §3.1 clocks | `packages/world-model/src/time.ts` |
| §3.2 fact envelope + factories | `packages/world-model/src/fact.ts` |
| §3.3–§3.4 observations, source interface | `packages/world-model/src/observation.ts` |
| §3.5 world state | `packages/world-model/src/state.ts` |
| §5.1 store + read interface | `packages/world-model/src/store.ts` |
| §5.2 reducer | `packages/world-model/src/fusion/reducer.ts` |
| §5.3 precedence | `packages/world-model/src/fusion/precedence.ts` |
| §5.4 confidence gate | `packages/world-model/src/fusion/confidence.ts` |
| §5.5 staleness, two-clock rule | `packages/world-model/src/fusion/staleness.ts` |
| §5.6 drift monitor | `packages/world-model/src/drift.ts` |
| §5.7 derived state | `packages/world-model/src/derived/registry.ts` |
| §5.8 history + deltas | `packages/world-model/src/history/{ring,delta}.ts` |
| §7.1 snapshot | `packages/world-model/src/snapshot.ts` |
| §4.1 GSI | `packages/gsi/src/{contracts,payload}.ts` |
| §4.2 log tail | `packages/log-tail/src/contracts.ts` |

Two things are deliberately **not** here:

- **The composition root (§8) and the `CapturePort` (§4.3).** They belong to `apps/desktop`, which
  is step 6. `packages/context` already declares the `CapturePort` shape it consumes.
- **Anything in `packages/protocol`.** REPO_SKELETON §2.2 sends cross-boundary types there *first*,
  but the package is step 2 and zod is its source of truth (§4) — hand-written types in it would be
  the drift the `protocol` skill warns about. So the vocabulary sits in `world-model`, and the two
  source packages mirror the ~20 lines of it they need, each marked ⚠ transitional. This matches
  what `packages/context` and `apps/desktop/src/shared` already do. The copies collapse when step 2
  lands, and `Observation` itself never crosses to Rust — the sidecar speaks protocol messages and
  the adapter in §4.3 wraps them, which is what keeps the wire format and this vocabulary free to
  diverge.

`packages/context/src/common/ports.ts` declares its own structural copies of `WorldModelReader`,
`WorldSnapshot` and `WorldDelta`, with a note to delete them when this package lands. They are
checked compatible: that `WorldModelReader` is method-for-method identical to `store.ts`'s, and its
`WorldSnapshot` is a strict subset of `snapshot.ts`'s, so the real types satisfy the declarations
without either side changing. Deleting the copies is that package's call to make, not this one's.

---

## 13. What the implementation changed

Assumption ⚑4 says a disagreement with these contracts is a reason to amend this file and the
contracts together rather than to diverge silently. This is that amendment. Everything here is a
change made while building §10 step 4, with the reason it was made.

### 13.1 Shape changes to `WorldState` (§3.5)

| Was | Is | Why |
|---|---|---|
| `self.abilities: readonly Fact<AbilityState>[]` | `Fact<readonly AbilityState[]>` | One POST observes every slot at one instant from one source, so per-slot provenance would be eight copies of the same stamp — and an array of facts is not addressable by `FieldPath`, which would put both fields outside precedence, ageing and delta computation. Still "every leaf a `Fact<T>`"; the array moved inside the envelope |
| `self.items: readonly Fact<ItemState>[]` | `Fact<readonly ItemState[]>` | Same |
| `map.wardsSeen: readonly Fact<MapPosition>[]` | `Fact<readonly MapPosition[]>` | One CV pass observes the whole visible ward set |
| `enemies[].itemsSeen: readonly Fact<ItemId>[]` | `ReadonlyMap<ItemId, Fact<ItemId>>` | Keyed so a second sighting refreshes the first instead of appending a duplicate. Each entry keeps its own age and confidence, which an array of anonymous facts could not preserve across re-observation. Addressed as `enemies.<hero>.itemsSeen.<itemId>` |
| — | `self.xp` added | `powerSpikeIn` cannot answer "how long until level 12" from a level alone, and GSI's `hero.xp` gives it for free |
| — | `enemies[].netWorth` added | `netWorthLead` needs all ten, and scoreboard CV is what supplies the other five |

`FieldPath` also acquired a grammar and two functions that walk it (`readFact`, `writeFact` in
`state.ts`). §5.2 and §5.8 both assume a leaf can be reached by name and neither said where that
lives; putting it anywhere but next to the state invites a second, subtly different copy.

### 13.2 Signature changes

- **`FusionOutcome.accepted: number`** (§5.2). `ApplyResult.accepted` is in §5.1, and the store
  cannot count what it never saw — only the reducer knows how many candidates an observation
  implied.
- **`WorldModelStore.paused: boolean`** (§5.1). `setPaused` was write-only, which is untestable and
  leaves the supervisor with nothing to render.
- **`PrecedenceOptions.confidenceWindowMs`** — see §5.3 rule 4 above.
- **`createConfidenceGate` and `createStalenessPolicy` take their tables as optional arguments**
  with documented defaults. Every call site would otherwise have to invent thresholds, which is how
  two of them end up different.
- **`emptyState(now, opts?)`** takes the history window, since the store owns it.

### 13.3 Behavioural notes not in the design

- **The rings are shared across versions.** `chat` and `history` are bounded append-only logs, not
  fields: they carry no `Fact` envelope, are not addressable by `FieldPath`, and never appear in a
  delta. Every version shares the same ring object, so a snapshot's view of them is as of the moment
  it is *read*, not the moment it was taken. This is the one deliberate exception to §7.1's
  immutability, and copying them per observation would make the guarantee uniform at the cost of an
  allocation per POST for a view nobody diffs. A chat line still bumps the version, or a chat-only
  observation would be invisible to `packages/events`.
- **`setPaused` has no body beyond recording the flag** (§6.4). It does not need one: `clock_time`
  stops advancing while paused and every tactical ageing policy is on the `game` basis, so tactical
  facts stop ageing as a *consequence of the clock* rather than of a flag. If that method ever grows
  a body, the two-clock rule has been worked around somewhere.
- **`position` expiring into `lastSeenAt`** (§3.5, §5.5) is implemented by writing both from the
  same reducer step and giving `lastSeenAt` a far longer expiry. No timer, no sweep, no mutation on
  read.
- **A non-GSI observation is stamped with the clock the model currently holds.** So a CV batch that
  arrives before the first GSI POST is stamped clockless and ages in wall time — correct, since
  there was no match clock to age it against, but surprising the first time it is seen.
- **CV detections carry their own `observedAt`**, and fusion uses it in preference to the batch's.
  A batch is assembled over one capture pass but its regions were sampled at different moments;
  ageing a minimap blob from arrival makes every position look fresher than it is, in the direction
  that gets someone killed.
- **§5.7's per-dependency memo is not implemented.** A rule's answer depends on `now` as well as on
  its inputs — that is what ageing means — so a cache keyed on dependency identity would need
  invalidating on every clock tick, which is every call. Laziness alone delivers the stated
  property: derived state is computed on first read *of a snapshot*, and seven of eight GSI updates
  never have a snapshot taken of them. `dependsOn` still earns its place by skipping rules none of
  whose inputs have ever been observed.

### 13.4 What the implementation could not verify

Both are §11 items and neither moved:

- **`previously`/`added` (§11.5)** are dropped in one place (`parse.ts`) so the assumption has a
  single site to change. Confirming it needs a live capture.
- **Console-log line formats.** `packages/log-tail`'s tailer is format-independent and tested
  against temp files; its *matchers* are a reconstruction from community reports, because dota2
  §2.3's "verify which events reach `console.log`" has not been run. `fixtures/console-log/` says so
  in its README, and the matcher registry exists precisely so that being wrong here breaks one small
  file.

`fixtures/gsi/` is likewise synthesised from §2.1's component list rather than recorded. It
exercises the pre-horn negative clock, irregular delivery, a pause, a partial POST, unknown
components and a heartbeat — but it cannot answer either question above, and its headers say so.

# Agent Command Execution — Module & Class Architecture

**Status:** Draft / design proposal. No implementation exists; `packages/context` is the step-5 stub.
**Scope:** The component that turns a command issued by the agent into an answer — parsing, validation,
admission, queueing, execution against the game data, error recovery, and rendering the result back
into the conversation. It is Tier 3 of [`dota2-state-capture-design.md`](dota2-state-capture-design.md) §6.3,
and it lives in `packages/context/src/tools/` per REPO_SKELETON.md §2.2.
**Reads with:** [`state-capture-architecture.md`](state-capture-architecture.md) §7 defines the read
interface this component consumes and should be read first; §4.3 of it defines the capture command port.
[`openai-realtime-research.md`](../research/openai-realtime-research.md) §5 and §11 supply the budget and
the failure modes. [`overlay-architecture.md`](overlay-architecture.md) §4.4 owns the consent surface.
**Out of scope:** The Tier 2 snapshot *text format* (dota2 §6.2 — same package, different task), salience
and the decision to speak (`packages/events`, dota2 §6.4), the Realtime wire protocol and session
lifecycle (`packages/realtime`), and fusion (`packages/world-model`).

---

## 0. Assumptions

Stated up front, house style. Sections marked ⚑ are what changes if one is wrong.

| # | Assumption | Source | Affects |
|---|---|---|---|
| C1 | **⚑ "Command" here means a tool call issued by the agent, executed against observed game data.** Riki sends nothing into the game. | ADR-0003, dota2 §6.3 | ⚑ everything. See below |
| C2 | **⚑ The agent's commands arrive as function calls on a Realtime session**, with a `call_id`, a name, and arguments as a JSON *string* accumulated from deltas | realtime §1, §8 | ⚑ §4.1, §4.2 — the adapter shape |
| C3 | A function call that is never answered stalls the turn rather than timing out server-side | realtime §11.6 (adjacent, not stated) | §7.4 — unverified, see §12 |
| C4 | Tool definitions are billed and cached with the session instructions, against a shared 16,384-token cap | realtime §1 *Models* | ⚑ §8.1, ADR-0011 |
| C5 | The world model is the only source of game facts this component may read, and it already carries provenance, confidence and age | state-capture §3.2, §7.1 | ⚑ §5, §7.2 |
| C6 | This document specifies interfaces, not implementations. No behaviour lands with it | house style (state-capture §0.4) | — |
| C7 | Numbers marked *(tunable)* are starting points to be measured. Numbers not so marked come from a design doc or from REPO_SKELETON | — | — |

**C1 is the one that decides what this component is.** The task that produced this document called it
"game command execution", which in most games would mean synthesising input. Here it cannot: ADR-0003
forbids injection, memory writes, and input synthesis, and is explicitly not open for re-litigation. What
Riki executes are *commands from the agent to Riki* — `get_enemy_detail(sf)`, `get_timings()` — which read
what has already been observed. The one command with any effect outside this process is `read_screen`,
which sends pixels to a VLM; that is why consent, rate limiting and an activity indicator exist in §5.4
and nowhere else.

If a future reader meant the sidecar control channel (`setRegionSchedule`, `recalibrate`, `requestRegion`)
— that is also "commands", and it is already designed in state-capture §4.3. This component *uses* it
(§5.2); it does not redefine it.

---

## 1. What this component is

Between the agent and the game state there is a gap that nothing else closes. `packages/world-model`
holds facts with provenance and age and has never heard of a turn. `packages/realtime` holds a session
and has never heard of a hero. Something has to accept `{"name":"get_enemy_detail","arguments":"{\"hero\":\"sf\"}"}`
off a wire and return 40 tokens of text that are true, current, appropriately hedged, and delivered before
the conversation moves on.

Concretely it is five things, and keeping them apart is most of the architecture:

1. **A registry** — the set of commands that exist, their argument schemas, their limits, and the manifest
   the model is shown. Data, not behaviour.
2. **A pipeline** — parse, validate, admit, execute, render, submit. Six stages, each of which can fail
   only *into a result*, never out of the pipeline (§3.4).
3. **A scheduler** — turn-scoped queueing, concurrency by effect class, deadlines, deduplication, and
   cancellation on barge-in.
4. **A set of ports** — the abstraction over "the game API": one read port, one capture command port, one
   reference-data port, one consent port. Handlers see nothing else.
5. **A set of handlers** — one file per command, each a function of its arguments and the ports.

### 1.1 Non-goals

- **This component does not decide when the agent speaks.** `packages/events` does (dota2 §6.4). Commands
  are pull, by definition — the agent asks, or nothing happens.
- **This component does not own the wire.** It never sees the string `response.function_call_arguments.done`.
  The Realtime event vocabulary is `packages/realtime`'s, and the beta/GA schema trap that the
  `voice-realtime` skill documents is confined there. The translation is an adapter in the composition
  root (§9.3), for exactly the reason the overlay's `VoiceBridge` exists.
- **This component does not fuse, age, or gate facts.** It reads a `WorldSnapshot` and renders it. A
  command that wanted to reconcile two sources would be fusion, in the wrong package, without a reducer.
- **This component holds no conversation state.** No transcript, no history of what the agent was told.
  Turn-scoped memory dies with the turn (§3.5). Retention across a match is `packages/realtime`'s
  problem and this design's §8.2 is an input to it.

---

## 2. The decomposition at a glance

```
              ┌──────────────────────── packages/realtime ────────────────────────┐
              │  session events: function_call name · arguments deltas · done      │
              └───────────────────────────────┬───────────────────────────────────┘
                                              │
              ┌───────────────────────────────▼───────────────────────────────────┐
              │  apps/desktop/src/main/agent/   COMPOSITION ROOT (§9.3)           │
              │  ToolCallBridge — accumulate deltas, submit results, forward       │
              │                   barge-in as cancelTurn. Knows both vocabularies. │
              └───────────────────────────────┬───────────────────────────────────┘
                                              │  RawToolCall  ▲  ToolResultMessage
                                              ▼               │
┌──────────────────────────── packages/context/src/tools ─────┴─────────────────────┐
│                                                                                   │
│   ToolRegistry ──► ToolManifest (frozen per session, §8.1)                         │
│        │                                                                          │
│        ▼                                                                          │
│   ToolCallParser ──► ArgumentCodec ──► SubjectResolver ──► AdmissionController     │
│        │                 (schema)         (hero/item/region)     │                │
│        │                                                         ▼                │
│        │                                                    ToolQueue (§6)        │
│        │                                                         │                │
│        └────────────────────────────────────────────────────────►│                │
│                                                                  ▼                │
│                                                            ToolExecutor            │
│                                                          watchdog · memo           │
│                                                                  │                │
│                                            handlers/<one file per command>         │
│                                                                  │                │
│                                                          ResultRenderer (§4.6)     │
└──────────────────────────────────┬────────────────────────────────────────────────┘
                                   │ ports — the only way out (§5)
      ┌────────────────┬───────────┴───────────┬──────────────────┐
      ▼                ▼                       ▼                  ▼
WorldModelReader   CapturePort           ReferenceDataPort    ConsentPort
(@riki/world-model) (→ Rust sidecar)     (external APIs)      (→ overlay Confirming)
```

Two properties of that graph are what make it modular rather than merely layered, and both are
inherited deliberately from state-capture §2.1:

- **Nothing flows back up.** A handler cannot reach the session, cannot speak, and cannot see another
  handler. It receives arguments and ports and returns an outcome.
- **The arrows are types.** `RawToolCall` in, `ToolResultMessage` out. Both sides of the bridge can be
  replaced by a fixture, which is why the whole pipeline is Tier 1 testable today, before
  `packages/realtime` exists.

### 2.1 Directory layout

```
packages/context/src/
├── tools/
│   ├── index.ts             public surface — buildToolSurface() and the types below
│   ├── types.ts             the vocabulary: calls, outcomes, failures, turn scope
│   ├── contracts.ts         registry, parser, executor, queue, admission — interfaces
│   ├── ports.ts             WorldModelReader, CapturePort, ReferenceDataPort, ConsentPort
│   ├── registry.ts          ToolRegistry + defineTool()
│   ├── manifest.ts          JSON Schema assembly + the token ceiling (§8.1)
│   ├── parse.ts             ToolCallParser
│   ├── resolve.ts           SubjectResolver — aliases, and "not in this match"
│   ├── admission.ts         AdmissionController — availability, consent, rate, budget
│   ├── queue.ts             ToolQueue, TurnScope, ResultMemo
│   ├── executor.ts          ToolExecutor + the watchdog (§7.4)
│   ├── render.ts            ResultRenderer, budget truncation, privacy gate
│   ├── handlers/            one file per command, eight of them (dota2 §6.3)
│   └── testing/index.ts     FakeToolPorts, RecordingConsentPort, fixed-clock helpers
├── snapshot/                Tier 2 — sibling task, not this document
└── preamble/                Tier 1 — sibling task, not this document
```

### 2.2 Why this split and not the obvious one

The obvious arrangement is one `tools.ts` with a switch statement over the command name, calling the
world model inline. Three things rule it out:

- **The failure paths outnumber the happy paths.** §7.1 lists ten distinct ways a command fails, every
  one of which must produce speakable text within a deadline. A switch statement gets the happy path
  right and grows the failure handling by accretion, per command, inconsistently. Putting parse,
  admission, and rendering *outside* the handlers means a new command inherits ten correct failure paths
  for free and can only get its own logic wrong.
- **Handlers must be trivially testable and the pipeline must be tested once.** A handler that also
  parses its own JSON needs a JSON test. Eight handlers, eight JSON tests, eight opportunities to be
  lenient in a different way.
- **The token budget is a global property.** Per-command truncation with no shared accounting cannot
  enforce a per-turn ceiling (§8.2), and a per-turn ceiling is what stops tool output from eating the
  28,672-token input window over a 40-minute match.

The cost is indirection: a command is a definition plus a handler plus a fixture rather than a function.
§14 argues that is still the cheapest change in the system.

### 2.3 The boundary lints this design needs

Per REPO_SKELETON §6.2 and the `workspace` skill's first learning, these land **with the implementation,
not before** — a rule that fires on nothing cannot be verified, and each must be proven by writing a
violating file, running `pnpm exec eslint` on it, watching it fail, and deleting it.

```js
// boundaries/external
{
  from: [['package', { name: 'context' }]],
  disallow: ['@riki/realtime', '@riki/gsi', '@riki/log-tail', 'electron'],
  message:
    'packages/context reads the world model through a port and speaks no vendor vocabulary — ' +
    'the Realtime translation lives in the composition root adapter.',
},
```

```js
// boundaries/element-types — handlers are leaves
{
  from: [['package', { name: 'context' }]],
  disallow: [['package', { name: 'context' }]],   // scoped to src/tools/handlers/** by pattern
  message: 'A command handler may not import another command handler.',
},
```

The first rule is the load-bearing one. `@riki/context` importing `@riki/realtime` would be the natural
way to submit a result, and it would pull the GA-schema trap, the session lifecycle, and the `openai` SDK
into the package that is supposed to be a pure function of a snapshot.

---

## 3. The vocabulary

These types are the contract. Everything else in this document is expressed in them, so they come first
and in the most detail. They live in `packages/context/src/tools/types.ts` and are scaffolded alongside
this document.

They deliberately do **not** live in `packages/protocol`: none of them crosses a process or language
boundary. Exactly one type here does — `ConsentRequest` (§5.4), which must reach the overlay renderer —
and §11 flags it as the protocol change this design will eventually require.

### 3.1 Identity and time

```ts
/** The session's id for one function call. Opaque; comes off the wire; the join key for everything. */
export type CallId = string & { readonly __brand: 'CallId' };

/** One agent turn. Every budget, memo, rate window and cancellation is scoped to it (§3.5). */
export type TurnId = string & { readonly __brand: 'TurnId' };

/** Local monotonic milliseconds. Same brand and same rule as state-capture §3.1. */
export type MonoMs = number & { readonly __brand: 'MonoMs' };
```

`MonoMs` is re-declared here rather than imported only because `packages/protocol` is still empty; §11
records that it collapses to one import when step 2 lands. The rule it encodes is not restated: never
wall-clock, because a fact's age must not move when NTP steps.

### 3.2 Effect class

Every command belongs to exactly one class, and the class — not the command — decides concurrency,
default deadline, consent, caching, and behaviour under degradation. This is the single most useful
classification in the design, because it means adding a command does not require deciding those five
things again.

```ts
export type ToolEffect = 'model' | 'reference' | 'observe' | 'consequential';
```

| Class | Commands (dota2 §6.3) | Reads | Concurrency | Deadline *(tunable)* | Consent | Cache |
|---|---|---|---|---|---|---|
| `model` | `get_enemy_detail`, `get_timings`, `get_recent_events`, `get_build_benchmark` | The current snapshot, in-process | Unbounded — it is a memory read | 20 ms | none | per turn |
| `reference` | `get_item_info`, `get_matchup_advice` | Cached external data, patch-keyed | 2 | 400 ms | none | per patch, on disk |
| `observe` | `get_minimap_summary` | Requests a fresh CV pass, then reads the snapshot | 1 | 600 ms | none | per turn |
| `consequential` | `read_screen` | Sends pixels off the machine | 1, and at most one per turn | 2500 ms | per call | never |

Two of those rows carry a decision:

- **`observe` is capped at one in flight** because a second concurrent request for the same region is
  strictly wasted: the first one's detections land in the model and the second would answer from the same
  version. Deduplication (§6.4) turns the second call into a wait on the first.
- **`consequential` is a class with one member and will stay that way** as long as ADR-0003 holds. It
  exists as a class rather than a special case so that the consent gate, the activity indicator and the
  rate limit are properties of a *category* — if a second consequential command is ever proposed, the
  question "does it need consent?" is already answered structurally.

### 3.3 A call, from wire to result

```ts
/** What the adapter hands in. `name` and `argumentsJson` are untrusted strings. */
export interface RawToolCall {
  readonly callId: CallId;
  readonly turnId: TurnId;
  readonly name: string;
  /** Accumulated from argument deltas. May be malformed, empty, or truncated (§4.1). */
  readonly argumentsJson: string;
  readonly receivedAt: MonoMs;
}

/** What survives parsing and validation. */
export interface ParsedCall<A = unknown> {
  readonly callId: CallId;
  readonly turnId: TurnId;
  readonly name: ToolName;
  readonly args: A;
  /** Canonicalised name + args. Two calls with the same fingerprint are the same question (§6.4). */
  readonly fingerprint: CallFingerprint;
  readonly receivedAt: MonoMs;
}

/** What the adapter submits back to the session. Exactly one per callId, always (§7.4). */
export interface ToolResultMessage {
  readonly callId: CallId;
  readonly name: string;
  /** Already rendered, already budgeted, already redacted. The model sees this and nothing else. */
  readonly output: string;
  readonly tokens: number;
  readonly status: 'ok' | ToolErrorCode;
  readonly elapsedMs: number;
}
```

`ToolResultMessage.status` is not for the model — the model only ever sees `output`. It is for telemetry
and for the Tier 4 assertion that the status distribution over a replayed match is sane. A rising
`timeout` rate is the cheapest possible detector for a port that has quietly stopped answering, and the
same argument as state-capture §5.1's `rejected` counter applies: this failure presents as *nothing*.

### 3.4 Outcomes and failures — the total-function rule

> **Every stage of the pipeline returns a value. Nothing in this component throws, and nothing rejects.**

```ts
export type ToolOutcome<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly failure: ToolFailure };

export interface ToolFailure {
  readonly code: ToolErrorCode;
  /** What the model is told. Written in Riki's voice, because the model will say it out loud. */
  readonly speakable: string;
  readonly retryable: boolean;
  /** Telemetry only. Never reaches the model, so it may name internals. */
  readonly detail?: string;
}

export type ToolErrorCode =
  | 'unknown_tool'
  | 'malformed_arguments'
  | 'invalid_arguments'
  | 'unknown_subject'
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'consent_denied'
  | 'cancelled'
  | 'internal';
```

Three consequences, all of them the point:

- **A failure is a result.** It is rendered, budgeted and submitted exactly like a success, because the
  session cannot tell the difference and must not have to. An exception escaping this component would
  leave a `call_id` unanswered, which is the one failure mode that stalls a voice conversation (§7.4).
- **`speakable` is content, not a diagnostic.** "I can't see the minimap right now" is a sentence a
  coach says. "ECONNREFUSED 127.0.0.1:53101" is not. Writing the user-facing half of the failure at the
  point where the failure is *classified* keeps them consistent across ten codes and eight commands, and
  it is the difference between degrading quietly to the user and degrading confusingly.
- **`detail` is separated by type**, not by convention, so the egress test in §13 has something
  structural to assert: nothing from `detail` ever appears in `output`.

### 3.5 Turn scope

Everything with a lifetime shorter than the match has this lifetime instead.

```ts
export interface TurnScope {
  readonly turnId: TurnId;
  readonly openedAt: MonoMs;
  /** Wall-clock ceiling for all command work in this turn (§6.3). */
  readonly deadlineAt: MonoMs;
  readonly signal: CancelSignal;
  /** Same question twice in a turn costs one execution (§6.4). */
  readonly memo: ResultMemo;
  spentTokens(): number;
  noteTokens(n: number): void;
}

export interface CancelSignal {
  readonly cancelled: boolean;
  readonly reason: CancelReason | null;
  onCancel(fn: (reason: CancelReason) => void): Unsubscribe;
}

export type CancelReason = 'barge_in' | 'turn_deadline' | 'session_closed' | 'match_ended';
```

The scope exists because of barge-in. When the player interrupts, `packages/realtime` truncates the
conversation item (the `voice-realtime` skill: skipping the truncate corrupts every later turn), and any
command result still in flight belongs to a message that no longer exists. Submitting it would inject an
answer to a question the conversation no longer contains. So cancellation is not an optimisation to save
work — it is a correctness requirement, and scoping it to a turn is what makes it a single call (§6.5).

---

## 4. The pipeline

Six stages. A call moves right until it produces a result; every stage's failure edge goes to the same
place, which is what makes the table in §7.1 exhaustive rather than aspirational.

```
 wire            §4.1        §4.2       §4.3        §4.4        §4.5      §4.6       §4.7
  │           accumulate    parse     validate     admit      execute    render    submit
  ▼               │           │          │           │           │          │         │
RawToolCall ──────┴───────────┴──────────┴───────────┴───────────┴──────────┴────────►│
                  │           │          │           │           │          │         │
                  ▼           ▼          ▼           ▼           ▼          ▼         ▼
             (adapter)   unknown_tool  invalid_    rate_limited  timeout   (never    ToolResult
                         malformed_    arguments   consent_      internal   fails —   Message
                         arguments     unknown_    denied        unavail-   it is
                                       subject     cancelled     able       total)
```

### 4.1 Accumulate — the adapter's job, not this component's

The Realtime API delivers a function call as a name plus a stream of argument deltas, terminated by a
done event. The bridge in the composition root accumulates them and hands over one `RawToolCall`.

**Partial arguments are never executed.** It is tempting — a 200 ms head start on a 600 ms capture is
real — and it is rejected for two reasons: the model sometimes emits arguments it then revises, and
gotcha §11.6 records that function-call arguments occasionally leak into spoken output, which is evidence
that the argument stream is not always the clean commitment it looks like. Speculating on a prefix means
executing a command the agent did not finish asking for. If the latency turns out to matter, the honest
version is prefetching for *zero-argument* commands on the name alone, which commits to nothing; §12
lists it as unverified.

### 4.2 Parse

```ts
export interface ToolCallParser {
  /** Total. A malformed payload is a value, not an exception. */
  parse(raw: RawToolCall): ToolOutcome<ParsedCall>;
}
```

In order: is the name a registered command (`unknown_tool`); is `argumentsJson` valid JSON
(`malformed_arguments`); does it satisfy the command's schema (`invalid_arguments`).

The name check is a real code path, not defensive programming. The model can and does call tools that do
not exist — usually ones it saw in a similar API, occasionally ones it invented. `unknown_tool` must
answer with the list of commands that *do* exist, because that both corrects the model within the turn
and costs less than a wasted round trip.

```ts
export interface ArgumentCodec<A> {
  /** Total. Never throws. */
  decode(raw: unknown): ToolOutcome<A>;
  /** What the model is shown. Generated from the same declaration as `decode`, never hand-written. */
  readonly schema: JsonSchemaObject;
}
```

**The schema and the validator must have one source.** zod is the repo's schema tool and
`packages/protocol` already generates JSON Schema from it; the same generation applies here. A
hand-written JSON Schema that has drifted from its validator is the exact failure `pnpm codegen` exists
to prevent for the sidecar, and it presents identically: the model is told a shape, sends it, and is
told it is invalid.

### 4.3 Validate — schema, then subject

Schema validation says the argument is a string. It does not say the string names a hero in *this match*,
and that distinction is where fabrication gets in.

```ts
export interface SubjectResolver {
  hero(spoken: string, subjects: MatchSubjects): Resolved<HeroId>;
  item(spoken: string): Resolved<ItemId>;
  region(spoken: string): Resolved<RegionId>;
}

export type Resolved<T> =
  | { readonly ok: true; readonly value: T; readonly matched: 'exact' | 'alias' | 'fuzzy' }
  | { readonly ok: false; readonly reason: 'unknown' | 'ambiguous' | 'not_in_match';
      readonly candidates?: readonly string[] };
```

The agent speaks the way a player does: `sf`, `shadow fiend`, `nevermore` are one hero; `bkb` and
`black king bar` are one item. Alias resolution is a lookup table and belongs in one place rather than in
eight handlers.

`not_in_match` is the reason this stage exists at all. `get_enemy_detail("pudge")` in a game with no
Pudge has exactly one correct answer — *"Pudge isn't in this game"* — and the failure to give it is how a
voice coach ends up confidently discussing a hero nobody is playing. Schema validation cannot catch it;
only the draft can. So `MatchSubjects` comes from the snapshot, and `unknown_subject` carries the
candidates so the model can correct itself in one turn instead of two.

`fuzzy` matches are admitted but recorded. A rising fuzzy rate means the alias table is behind a patch,
which is a maintenance signal available for free.

### 4.4 Admit

The last gate before work happens, and the only stage that can answer without executing.

```ts
export interface AdmissionController {
  admit(call: ParsedCall, scope: TurnScope, now: MonoMs): Admission;
}

export type Admission =
  | { readonly verdict: 'admit' }
  | { readonly verdict: 'serve_memo'; readonly fingerprint: CallFingerprint }
  | { readonly verdict: 'consent'; readonly request: ConsentRequest }
  | { readonly verdict: 'refuse'; readonly failure: ToolFailure };
```

Checks, in this order, cheapest first:

1. **Memo** — this exact question was answered earlier in this turn (§6.4). Serve it.
2. **Availability** — is the port this command needs alive? Under `gsi_only` degradation,
   `get_minimap_summary` cannot produce anything fresh. It is still *advertised* (§8.1); it answers
   `unavailable`, or better, answers from the model with ages attached (§7.2).
3. **Rate** — `read_screen` is capped at 0.2 Hz by dota2 §5, and the cap is enforced here rather than
   inside the handler so that a rate-limited call costs nothing and still answers.
4. **Turn budget** — tokens already spent on command output this turn (§8.2).
5. **Consent** — `consequential` only.

Ordering matters: a consent prompt for a command that was going to be rate-limited anyway would put a
question on the player's screen for no reason.

### 4.5 Execute

```ts
export type ToolHandler<A, R> = (args: A, ctx: ToolContext) => Promise<ToolOutcome<R>>;

export interface ToolContext {
  readonly ports: ToolPorts;
  readonly scope: TurnScope;
  readonly now: MonoMs;
  /** Deadline for *this* call, already the minimum of the command's limit and the turn's remainder. */
  readonly deadlineAt: MonoMs;
}
```

A handler is a function of its arguments and its ports. It has no `this`, no clock of its own, no access
to the registry, and no way to reach the session. A Tier 1 test for a handler is: build `FakeToolPorts`,
call it, assert the outcome — no fixtures beyond the ones `packages/world-model` already needs.

Handlers are also where the *shape* of the answer is decided but not its text. `get_enemy_detail` returns
a structure of `{ fact, staleness }` pairs; turning that into 40 tokens is §4.6's job. The separation is
what makes the rendered output golden-testable independently of the data.

### 4.6 Render

```ts
export interface ResultRenderer<R> {
  render(value: R, ctx: RenderContext): RenderedResult;
}

export interface RenderContext {
  readonly now: MonoMs;
  readonly clock: GameClock | null;
  readonly maxTokens: number;
  readonly privacy: PrivacyPolicy;
}

export interface RenderedResult {
  readonly text: string;
  readonly tokens: number;
  readonly truncated: boolean;
  /** What the budget or the confidence gate dropped. Telemetry and golden tests. */
  readonly omitted: readonly string[];
}
```

The rendering rules are the snapshot's rules (dota2 §6.2, and the `agent-context` skill), and they are
not restated so much as *reused* — the same renderer primitives serve Tier 2 and Tier 3, which is the
main reason both live in `packages/context`:

- **A stale fact renders with its age and confidence or it does not render.** `sf bot 4s ago(0.91)`,
  never `sf is bot`. The type system helps: handlers return `{ fact, staleness }`, mirroring
  `WorldSnapshot.get()`, so a bare value is not available to render even by mistake.
- **Below-threshold facts are dropped, not hedged.** Hedging spends tokens to say nothing.
- **Truncation is priority-ordered and recorded.** `truncated` and `omitted` exist so a golden test can
  assert *what* survived a tight budget, which is a design decision, not an accident.
- **Privacy is a render input.** Chat text is `sensitive` at the source (state-capture §4.2);
  `PrivacyPolicy` is the second of the two independent gates, and `get_recent_events` is the command that
  would otherwise carry other players' words into a third-party API. Default off, asserted by test.

### 4.7 Submit

The executor returns a `ToolResultMessage`; the bridge submits it. This component does not know what
submission looks like on the wire, and the invariant it does own is §7.4's: exactly one message per
`callId`, within the deadline, no matter what happened.

---

## 5. The ports — the game API abstraction

Four ports, and handlers may touch nothing else. This is what the scope calls "game API interaction and
abstraction": the game's several very different data channels — a local HTTP listener, a Rust sidecar over
stdio, a rotating log file, an HTTP API with a disk cache — are already unified by the time they reach
here, into one read interface plus one command interface.

```ts
export interface ToolPorts {
  readonly world: WorldModelReader;
  readonly capture: CapturePort;
  readonly reference: ReferenceDataPort;
  readonly consent: ConsentPort;
  readonly clock: Clock;
  readonly telemetry: ToolTelemetry;
}
```

### 5.1 `WorldModelReader` — every game fact, one way in

Defined by state-capture §7.1 and imported unchanged. Three methods: `snapshot(now)`,
`onVersion(listener)`, `history(since)`.

**No command reads a source.** Not GSI, not the log tailer, not the sidecar. Everything a handler can
know has been through fusion, precedence, the confidence gate and ageing exactly once, which is the only
way the guarantees those policies provide actually reach the agent. A command that bypassed the model to
"get a fresher number" would be a second path for a CV fact to reach the LLM — one with no precedence, no
confidence gate, and no age — and state-capture §4.3 rejects that for the same reason in the other
direction.

### 5.2 `CapturePort` — the only outbound command channel

Also state-capture's (§4.3), also unchanged: `requestRegion` resolves with a *request id*, not with
detections. The detections arrive by the normal observation path.

`get_minimap_summary` therefore does not "call the sidecar and get an answer". It asks for a fresh pass
and waits for the model to change:

```ts
export interface FreshCaptureRequest {
  /** Resolves on the first version bump containing the region, or fails on timeout. */
  request(region: RegionId, timeoutMs: number, signal: CancelSignal): Promise<ToolOutcome<WorldSnapshot>>;
}
```

This is the most important structural decision this component inherits, and it is worth restating why the
indirect path is the right one: it means there is exactly one way for a pixel to become something the
agent is told, and every stale, low-confidence or contradicted detection is filtered by the same code
whether it arrived on a schedule or because the agent asked.

### 5.3 `ReferenceDataPort` — the data that is not about this match

```ts
export interface ReferenceDataPort {
  item(id: ItemId): Promise<ToolOutcome<ItemInfo>>;
  matchup(a: HeroId, b: HeroId): Promise<ToolOutcome<MatchupNote>>;
  benchmark(hero: HeroId, at: GameClock): Promise<ToolOutcome<BuildBenchmark>>;
}
```

Patch-keyed, disk-cached, and the same port Tier 1 preamble assembly uses for draft enrichment — which is
the argument for it being a port rather than an inline fetch. It is also the one port that can be slow in
a way the player notices, so its deadline is short and a miss is a plain `unavailable`: reference data is
by definition not urgent, and dota2 §2.4 already treats it as best-effort.

Ownership of external API enrichment has no home in REPO_SKELETON §2.2; state-capture §11.3 placed it
provisionally in `packages/context` and flagged it. This design uses it from two places (preamble and two
commands), which strengthens rather than settles the case for its own package. Still open (§15).

### 5.4 `ConsentPort` — and the indicator

```ts
export interface ConsentPort {
  request(req: ConsentRequest, signal: CancelSignal): Promise<ConsentDecision>;
  /** The indicator is up for the whole activity, not just the prompt. */
  begin(activity: ConsequentialActivity): ActivityHandle;
}

export interface ConsentRequest {
  readonly callId: CallId;
  readonly kind: 'read_screen';
  /** Short, specific, and in the player's terms: "Look at the scoreboard?" */
  readonly prompt: string;
  readonly region: RegionId;
  readonly expiresAt: MonoMs;
}

export type ConsentDecision = 'granted' | 'denied' | 'expired';
```

Three decisions live in that small interface:

- **Consent is per call, by default.** dota2 §7's privacy defaults and the `config-secrets` skill's rule
  that the invasive default stays off both point the same way. A "remember for this match" grant is
  plausible and is left open (§15) rather than assumed, because the cost of being wrong is a screenshot
  the player did not expect.
- **`begin()` is separate from `request()`** because dota2 §7 asks for an *unmistakable indicator* while
  capture is happening, and a prompt that disappears on `Y` is not that. The overlay's Acting state is
  the indicator (overlay-architecture §4.4), and it is driven by the activity handle, so the indicator
  cannot outlive or under-live the capture.
- **`expired` is a distinct decision, not a denial.** A prompt the player never noticed produced no
  refusal; recording it as one would poison any future "they always say no" heuristic. All three map to
  the same speakable answer today.

`ConsentRequest` crosses main → renderer, so per REPO_SKELETON §4 it belongs in `packages/protocol` as a
zod schema. That package is step 2 and still empty; §11 records the move as a coordination event.

### 5.5 Why ports rather than clients

A handler that constructed its own HTTP client would be untestable without a network, would read config
it should be injected, and would put a retry policy in eight places. More importantly, ports are what let
this entire component be exercised in Tier 1 today: `FakeToolPorts` satisfies all four, and REPO_SKELETON
§5.2's rule about shared fakes applies — `pnpm dev:replay` drives the real pipeline against fakes rather
than a parallel test-only path.

---

## 6. Queueing and execution

### 6.1 The queue

```ts
export interface ToolQueue {
  enqueue<T>(
    call: ParsedCall,
    effect: ToolEffect,
    run: (signal: CancelSignal) => Promise<T>,
  ): Promise<QueueOutcome<T>>;
  cancel(turnId: TurnId, reason: CancelReason): void;
  depth(): ReadonlyMap<ToolEffect, number>;
}
```

The queue exists because the agent may issue several commands for one turn, and because two of the four
effect classes must not run concurrently with themselves. It is per effect class, not global: a
`model` read waiting behind a `read_screen` would be absurd — it is a memory access behind a network
round trip.

### 6.2 Concurrency

The limits are §3.2's table. The reasoning, once, rather than per command: `model` reads are unbounded
because they are synchronous work wearing a promise; `reference` is bounded at 2 to stay polite to an
external API; `observe` at 1 because concurrent requests for the same region answer from the same model
version; `consequential` at 1 per turn because more than one screenshot per question is not a thing a
player would expect and the rate limit would refuse it anyway.

### 6.3 Deadlines

Two deadlines, and the effective one is always the minimum:

- **Per command**, from §3.2's table.
- **Per turn** — `turnDeadlineMs`, 1200 ms *(tunable)*. This is the budget that matters, and it comes
  from realtime §7: the conversational latency floor is already 1–2 s, and command work is *added* to it.
  A turn that spends 3 s gathering perfect detail has produced a coach who answers after the fight.

When the turn deadline passes, queued-but-unstarted calls are not executed; they answer `timeout`
immediately. This is deliberate and slightly counter-intuitive — the work might have been quick — but a
result that arrives after the model has already spoken is worse than useless: it is context the retention
policy will carry for the rest of the match having contributed nothing.

### 6.4 Deduplication

```ts
export interface ResultMemo {
  get(fp: CallFingerprint): ToolResultMessage | undefined;
  set(fp: CallFingerprint, result: ToolResultMessage): void;
  /** A call already in flight for this fingerprint — join it rather than starting a second. */
  inflight(fp: CallFingerprint): Promise<ToolResultMessage> | undefined;
}
```

Two calls with the same fingerprint in one turn are the same question. The model repeats itself,
particularly under interruption, and particularly with zero-argument commands. Joining the in-flight
promise rather than starting a second execution is what stops one repeated `get_minimap_summary` from
becoming two capture requests.

Scoped to the turn, never longer: a memo that survived into the next turn would answer a question about
*now* with a snapshot from before the fight.

### 6.5 Cancellation and barge-in

```
Speaking ──player interrupts──► realtime truncates the item
                                        │
                                        ▼
                        executor.cancelTurn(turnId, 'barge_in')
                                        │
              ┌─────────────────────────┼──────────────────────────┐
              ▼                         ▼                          ▼
     queued calls answer       in-flight handlers see       nothing from this turn
     'cancelled' and are       signal.cancelled and         is ever submitted
     never executed            unwind; capture requests
                               are abandoned, not awaited
```

The rule that makes this correct: **a cancelled call produces a result object and does not submit it.**
The distinction matters — the executor still resolves (so the bridge's promise does not leak, and
`no-floating-promises` has something to hold), but the bridge drops results whose turn has been
cancelled, because the conversation item they answer no longer exists.

An in-flight `read_screen` at barge-in is the interesting case: the capture may already have happened.
The activity handle is ended, the pixels are discarded, and the rate-limit clock still ticks — the
player's screen *was* read, and pretending otherwise to the rate limiter would let a barge-in loop
sidestep the cap.

---

## 7. Error handling and recovery

### 7.1 The taxonomy

Ten codes, exhaustively. Every failure edge in §4 lands in exactly one row, and every row has a
`speakable` string written once.

| Code | Raised by | The model is told | Retryable | Telemetry signal |
|---|---|---|---|---|
| `unknown_tool` | Parse | "That isn't something I can look up. I can check: …" | no | Model drift, or a manifest that failed to load |
| `malformed_arguments` | Parse | "I didn't catch what to look up — say the hero again?" | no | Rising rate means the schema is confusing the model |
| `invalid_arguments` | Validate | Same, with the expected shape | no | As above |
| `unknown_subject` | Resolve | "Pudge isn't in this game." / candidates | no | Fuzzy-match rate tracks alias-table staleness |
| `unavailable` | Admit / Execute | "I can't see the minimap right now." | later | The degradation level, reflected honestly |
| `timeout` | Watchdog | "That's taking too long — ask me again in a second." | later | **The most important counter here** (§3.3) |
| `rate_limited` | Admit | "I just looked — give it a moment." | later | `read_screen` pressure; also a cost signal |
| `consent_denied` | Admit | "Okay, I won't look." | no | Never phrased as an error to the player |
| `cancelled` | Turn scope | *(never submitted — §6.5)* | — | Barge-in frequency |
| `internal` | Anything unexpected | "Something went wrong on my end." | no | Should be zero; a non-zero rate is a bug, not a condition |

`internal` is the catch-all that makes the total-function rule true rather than aspirational: the
executor wraps every handler so that a thrown exception becomes this row instead of an unanswered call.
It is also the only row that should never appear, which is what makes it a useful alert.

### 7.2 Degrade to a marked answer, not to silence

The default recovery is not "report unavailable". It is **answer with what the model already holds,
marked with its age**, and report unavailable only when there is nothing observed at all.

| Situation | Wrong answer | This design's answer |
|---|---|---|
| Sidecar dead, minimap asked for | "I can't see that" | The last known positions, each with its age and confidence, plus that they are not fresh |
| GSI silent 20 s, self-state asked for | Current values as facts | The values, aged; `expired` fields absent rather than guessed |
| Fresh capture times out | "I can't see that" | The pre-request snapshot, aged — the request failed, the memory did not |
| Nothing has ever been observed | A plausible guess | `unavailable` — "I can't see that right now" |

This is the same judgement dota2 §4 rule 3 makes for the snapshot, applied one layer out: an old fact
labelled old is useful, a guess presented as current is the worst outcome the product has, and *silence
about something we do know* is a coach who seems broken. state-capture §7.2 gives the timeout branch as
"I can't see that right now" — that remains exactly right for the never-observed case, which is the one
it was written about.

### 7.3 The circuit breaker

```ts
export interface PortBreaker {
  note(port: PortId, outcome: 'ok' | 'fail', now: MonoMs): void;
  state(port: PortId, now: MonoMs): 'closed' | 'open' | 'half_open';
}
```

Consecutive failures *(tunable: 3)* open the breaker for a port; while open, commands needing it are
refused at admission in microseconds instead of spending the turn deadline discovering the same thing
again. Half-open lets one call through after a cooldown *(tunable: 15 s)*.

The reason this is worth having in a component with a 1200 ms turn budget: without it, a dead sidecar
costs *every* turn its full `observe` deadline, and the player experiences a coach who has become slow
rather than one who has lost a source. The breaker converts a latency failure into an availability
failure, which is the one this component can explain.

Breaker state is advisory and is superseded by real health: `SourceSupervisor` (state-capture §8.1)
already knows the sidecar is down, and admission prefers that signal when it has one.

### 7.4 The watchdog and the one-result invariant

> **Every `callId` handed to `invoke()` produces exactly one `ToolResultMessage`, within
> `deadlineAt`, no matter what the handler does.**

```ts
export interface ToolExecutor {
  invoke(raw: RawToolCall, scope: TurnScope): Promise<ToolResultMessage>;
  cancelTurn(turnId: TurnId, reason: CancelReason): void;
  stats(): ExecutorStats;
}
```

The watchdog is a timer per call, not per queue: it resolves the result with `timeout` at the deadline
whether or not the handler has returned, and a late handler's value is discarded (and counted). Nothing
in the design prevents a handler from hanging — a promise that never settles is always possible — so the
guarantee has to come from outside it.

This is the single most important reliability property in the component, and it is why `invoke` returns
a promise that always resolves rather than one that can reject. Assumption C3 is that an unanswered
function call stalls the turn; even if C3 turns out to be wrong (§12), the model's behaviour under
missing results is documented as *hallucinating one* (realtime §11.6), which is worse than a timeout
message. Both readings agree on the design.

### 7.5 What this component cannot fix

The model sometimes claims a command result it never received, and sometimes speaks argument JSON aloud
(realtime §11.6). Neither is fixable here, and pretending otherwise would be worse than naming it:

- **What helps:** never leaving a call unanswered (§7.4) removes the vacuum the model fills, and short
  deadlines mean the wait is never long enough to invite one.
- **What detects it:** `ExecutorStats` counts calls issued and results submitted; comparing that against
  the session transcript is a Tier 4 assertion, not a runtime guard.
- **What does not help:** validating the model's *output* against what we returned. That is a
  `packages/realtime` concern at best, and at worst it is a second model in the hot path.

---

## 8. The manifest and the token budget

### 8.1 The manifest is frozen for the session — ADR-0011

Command definitions are sent in `session.update` alongside the instructions, against a **16,384-token
shared cap**, inside the cached prefix (realtime §1, §5). Two consequences:

- **Every command costs prefix tokens for the whole session**, whether or not it is ever called. The
  manifest has a ceiling — 2,000 tokens *(tunable)* — asserted by a Tier 1 test, because "we added a
  tool" is otherwise an invisible tax on every turn's cached input.
- **Changing the manifest mid-session rewrites the prefix and busts the cache**, which realtime §5 names
  as the cost and latency cliff of a long session. A 40-minute match with degradation-driven manifest
  churn would bust it repeatedly.

Therefore: **availability is a property of the result, never of the manifest.** When the sidecar dies,
`get_minimap_summary` stays advertised and answers with aged facts or `unavailable`. The manifest is
computed once at `match_started` and frozen.

```ts
export interface ToolRegistry {
  register<A, R>(def: ToolDefinition<A, R>): void;
  lookup(name: string): ToolDefinition<unknown, unknown> | undefined;
  names(): readonly ToolName[];
  /** Computed once per session and frozen (ADR-0011). */
  manifest(env: ManifestEnvironment): ToolManifest;
}

export interface ToolManifest {
  readonly tools: readonly ManifestEntry[];
  readonly estimatedTokens: number;
  readonly frozenAt: MonoMs;
}
```

`ManifestEnvironment` carries the config that legitimately changes the *set* — `RIKI_VISION=off` removes
the vision-backed commands, because there is no point advertising a capability the build does not have —
and that decision is made once, before the session opens, not during it.

### 8.2 Result budgets

Two ceilings, both enforced by the renderer:

- **Per command**, `maxResultTokens`, from the definition. `get_enemy_detail` ≈ 120, `get_recent_events`
  ≈ 200, `read_screen` ≈ 300 *(all tunable)*.
- **Per turn**, `turnResultTokens` ≈ 600 *(tunable)*, tracked on the `TurnScope`. When exceeded,
  admission refuses further commands with `rate_limited` rather than truncating everything to
  uselessness.

The reason for a *turn* ceiling and not just a per-command one: command results are the fastest-growing
part of the conversation. The snapshot is re-rendered per turn and replaces itself; command results
accumulate in history and are billed as input on every subsequent turn until the retention policy drops
them. Against a 28,672-token practical ceiling over a 40-minute match, that growth is the thing most
likely to hit the wall first.

**This is a seam with `packages/realtime`, and this design's recommendation is explicit:** command
results should be the *first* thing that package's retention policy drops, ahead of conversation turns.
A stale answer to a question about a fight that ended ten minutes ago has no residual value, while the
conversation around it does. That package owns the call; §15 records it as unsettled.

---

## 9. Integration

### 9.1 Every counterpart, in one table

If a row is not here, this component does not talk to it.

| Counterpart | Direction | Carried by | What flows |
|---|---|---|---|
| `packages/realtime` | in | `ToolCallBridge` | function call name, argument deltas, done, turn open/close |
| `packages/realtime` | out | `ToolCallBridge` | `ToolResultMessage` → one conversation item per call |
| `packages/realtime` | in | `ToolCallBridge` | barge-in → `cancelTurn('barge_in')` |
| `packages/world-model` | in | `WorldModelReader` | `snapshot()`, `onVersion()`, `history()` |
| `crates/riki-vision` | out | `CapturePort` | `requestRegion` for `observe` and `consequential` commands |
| External APIs | out | `ReferenceDataPort` | item, matchup, benchmark lookups; patch-keyed disk cache |
| `apps/desktop` overlay | out | `ConsentPort` | consent request → Confirming; activity handle → Acting |
| `packages/config` | in | injected | `RIKI_VISION`, privacy flags, tunables. Never `process.env` |
| `packages/telemetry` | out | `ToolTelemetry` | per-command latency, status distribution, token spend, breaker state |
| `packages/events` | — | — | **No edge.** Events decide when to speak; commands are pull-only |

The last row is worth its space. It would be natural for the trigger policy to "run a command to check
something before deciding" — and it must not, because that inverts the pull model, puts capture requests
on the salience path, and gives `packages/events` a reason to know about tokens.

### 9.2 One turn, end to end

```
turn opens  ──► snapshot() rendered (Tier 2, ~5 ms)          ─┐
                                                              │  packages/context
            ──► agent decides it needs detail                 │
                                                              │
            ──► function_call arrives ──► pipeline (§4) ──────┤  ≤ turn deadline 1200 ms
                     └─ may be several, queued by class       │
                                                              │
            ──► results submitted ──► agent speaks           ─┘

  barge-in at any point ──► cancelTurn ──► nothing from this turn is submitted (§6.5)
```

The snapshot is rendered at turn start and command results arrive during it. They are not the same
mechanism and must not share a budget: the snapshot is the *view*, refreshed and replaced; commands are
*questions*, accumulated. Conflating them is how a per-turn token ceiling ends up truncating the
self-state the snapshot guarantees.

### 9.3 The composition root

Nothing above constructs anything. Wiring lives in `apps/desktop/src/main/agent/`, alongside the state
subsystem's root (state-capture §8) and the overlay's adapters:

```ts
export function buildAgentSubsystem(deps: {
  readonly config: RikiConfig;
  readonly clock: Clock;
  readonly state: StateSubsystem;      // reader + capture port (state-capture §8)
  readonly consent: ConsentPort;       // the overlay's Confirming surface
  readonly reference: ReferenceDataPort;
}): AgentSubsystem;

export interface AgentSubsystem {
  readonly manifest: ToolManifest;
  readonly bridge: ToolCallBridge;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

`ToolCallBridge` is the adapter that holds both vocabularies — the only file in the repo that knows both
`response.function_call_arguments.done` and `RawToolCall`. Same pattern, same reason as the overlay's
`VoiceBridge`: when the Realtime event names change, and openai-realtime-research §3 documents that they
already did once silently, the diff is one file with a table in it.

**`apps/desktop/src/main/agent/` is a new directory that REPO_SKELETON §2.2 does not mention**, which
lists main/ as "lifecycle, tray, global hotkeys, window mgmt, sidecar supervisor, IPC host". It is
composition, not domain logic, and it sits where the state subsystem's root already sits. Flagged in §15
as an ownership gap for whoever updates the map.

---

## 10. Failure modes

The dota2 §9 table, for this component. Every row degrades loudly to the developer, quietly to the
player, and never silently into wrongness.

| Failure | Detected by | Response |
|---|---|---|
| Model calls a command that does not exist | Parser | `unknown_tool` with the real list; counted |
| Arguments are not valid JSON | Parser | `malformed_arguments`; counted. A rising rate means the schema confuses the model |
| Hero named is not in this match | `SubjectResolver` | `unknown_subject` with candidates — never a fabricated answer |
| Sidecar down, `observe` command called | Admission via supervisor health, or breaker | Aged facts from the model; `unavailable` only if never observed (§7.2) |
| GSI silent, `model` command called | Staleness on the facts themselves | Answer with ages; expired fields absent, never guessed |
| Fresh capture times out | Watchdog | Pre-request snapshot with ages; capture request abandoned |
| Reference API down | `ReferenceDataPort` | Cached answer if the patch matches; else `unavailable` |
| Handler hangs | Watchdog (§7.4) | `timeout` at the deadline; late value discarded and counted |
| Handler throws | Executor wrapper | `internal`; should never happen, so it alerts |
| Player denies consent | `ConsentPort` | `consent_denied` — "Okay, I won't look." Not an error |
| Player never answers the prompt | Consent expiry | `expired`, recorded distinctly from denial (§5.4) |
| Barge-in mid-command | `cancelTurn` | Everything unwinds; nothing submitted; `read_screen` still counts against its rate limit |
| Match ends mid-command | `cancelTurn('match_ended')` | Same, plus the memo and per-match counters reset |
| Turn budget exhausted | `TurnScope` | Further commands refused at admission, not truncated to noise |
| Same command twice in a turn | Memo | Second call joins the first; one execution |

---

## 11. Module boundaries

| Boundary | Rule | Held by |
|---|---|---|
| `packages/context` → `packages/realtime` | Forbidden | Lint to add (§2.3) — the vendor vocabulary stays in the adapter |
| `packages/context` → `packages/gsi`, `log-tail` | Forbidden | Lint to add — game facts arrive only via `WorldModelReader` |
| `packages/context` → `apps/*` | Forbidden | Existing rule (§6.2) |
| `packages/context` → `electron` | Forbidden | Lint to add — this package must run in a bare vitest process |
| handler → handler | Forbidden | Lint to add — handlers are leaves |
| `process.env` | Only `packages/config` | Existing rule |
| `console.*` | Only `packages/telemetry` | Existing rule — hence `ToolTelemetry` as a port |

One type in this design will move: **`ConsentRequest` and `ConsentDecision` cross main → renderer**, so
per REPO_SKELETON §4 they belong in `packages/protocol` as zod schemas with generated JSON Schema. The
package is step 2 and still empty, so they are declared here with a note, exactly as the overlay's
`OverlayCommand` is. Moving them is a coordination event and the `protocol` skill applies.

`MonoMs`, `GameClock`, `HeroId`, `ItemId`, `RegionId` and `WorldSnapshot` are declared structurally in the
scaffolded contracts for the same reason and collapse to imports from `@riki/protocol` and
`@riki/world-model` when those land. That is not a design position — it is a consequence of writing this
before step 2, and it should be cleaned up rather than preserved.

---

## 12. Claims to verify before building on them

House style: what has been read versus what has been measured. None of the following has been measured
on this project, and three of them would change the design.

| Claim | How to check | Consequence if wrong |
|---|---|---|
| A function call left unanswered stalls the turn (C3) | Fixture replay against a live session; withhold one result | Severity drops, design does not change — §7.4 is still right because of realtime §11.6 |
| The Realtime API can emit multiple function calls in one response | Read the GA event reference; record a session that should provoke it | ⚑ The queue collapses to one slot and §6.2 is over-engineering |
| A mid-session `session.update` with a changed tool list busts the cached prefix (C4) | Compare cached-input billing across an update | ⚑ ADR-0011 relaxes to a preference |
| Tool definitions are tokenized as verbatim JSON Schema against the 16,384 cap | Tokenize a manifest and compare against reported usage | The 2,000-token ceiling number changes; the ceiling stays |
| Command results are billed as input on every later turn until truncated | Cost accounting over a long replayed session | ⚑ §8.2's per-turn ceiling and the retention recommendation both weaken |
| A 1200 ms turn deadline is perceptible-but-acceptable | Human judgement against a real session; realtime §7 puts the floor at 1–2 s already | The number moves; it is *(tunable)* for this reason |
| Zero-argument prefetch on the name alone is safe (§4.1) | Check whether a name can arrive and then be revised | An easy latency win, or a discarded idea |

The second row is the one to check first, because it is cheap and it decides whether §6 is necessary
complexity or unnecessary.

---

## 13. Testing map

Tiers are REPO_SKELETON §5.3. The decomposition exists so that almost all of it is Tier 1, testable today
against `FakeToolPorts` with no game, no session, and no network.

| Unit | Tier | Asserts |
|---|---|---|
| `ToolCallParser` | 1 | Unknown name, malformed JSON, empty string, valid call; never throws for any input |
| `ArgumentCodec` | 1 | Schema and validator agree — property test: anything the schema permits, `decode` accepts |
| `SubjectResolver` | 1 | Alias table, ambiguity, and `not_in_match` against a fixture draft |
| `AdmissionController` | 1 | The §4.4 order, table-driven: memo, availability, rate, budget, consent |
| `ToolQueue` | 1 | Per-class concurrency; deadline eviction; cancel drains without leaking a promise |
| `ResultMemo` | 1 | Identical fingerprints join; different arguments do not; scope dies with the turn |
| `ResultRenderer` | 1 | Age and confidence present on every CV-derived field; below-threshold dropped; truncation priority |
| Privacy gate | 1 | **Egress test**: with default config, chat text never appears in any `output` (dota2 §7) |
| Failure taxonomy | 1 | Every `ToolErrorCode` has a non-empty `speakable`; no `detail` string is reachable from `output` |
| Manifest | 1 | `estimatedTokens` ≤ ceiling; `RIKI_VISION=off` removes the vision commands |
| Watchdog | 1 | A handler that never settles still produces exactly one `timeout` result |
| **One result per call** | 1 | Property test over random pipelines: for every `RawToolCall`, exactly one message, always |
| Each handler | 1 | Fake ports in, outcome out; and inputs-too-stale → the aged answer, not silence |
| Rendered results | 2 | Golden, `fixtures/golden/tools/` — the format is an interface to the LLM, so it is a diff |
| `ConsentRequest` | 3 | Once it moves to `@riki/protocol` — round-trip through the contract corpus |
| Full pipeline | 4 | Replayed match + `FakeVisionSidecar`: command latency budgets, the §10 table, barge-in mid-command |
| Consent flow | 5 | Playwright: `read_screen` shows Confirming, `Y`/`N`/`Esc` map to the three decisions, Acting is visible for the whole capture |

Two of those deserve their emphasis. **The one-result property test** is the executable form of §7.4 and
the only test that guards the invariant across every future handler. **The egress test** is the one that
cannot be walked back once it fails in production, and it is cheap: build a snapshot containing chat,
render every command, assert absence.

---

## 14. Extensibility

What each change costs. If one of these is expensive, the boundaries are wrong.

**Add a command** — one file in `handlers/`, one `register()` call, one golden fixture, and a re-measure
of the manifest ceiling. No existing module changes behaviour. The manifest re-measure is not
bureaucracy: §8.1 makes every command a permanent tax on the cached prefix, and the number is the only
thing that keeps that visible.

**Add an argument to an existing command** — the codec, its schema (generated, not hand-written), and the
golden fixture. The model sees a changed schema, so it is a session-prefix change: land it, do not
hot-swap it.

**Add a port** — a field on `ToolPorts`, a fake in `testing/`, and an availability probe. Justified only
by a genuinely new kind of source; a third HTTP API is `ReferenceDataPort`'s job, not a new port's.

**Add an effect class** — the §3.2 table plus a queue lane. Expected to happen approximately never; the
four classes cover read, fetch, observe, and act, and ADR-0003 caps the fourth at one member.

**Change how a result reads** — `render.ts` and a golden diff. Zero handler changes. This is the change
that will happen most often, because it is prompt engineering by another name, and it is deliberately the
cheapest.

**A command that needs data the world model does not have** — that is a `packages/world-model` change
(a derived rule, one file, per state-capture §9), not a change here. If it seems to need a change to
*fusion*, the model is being asked to know it is feeding an LLM, and state-capture §7.3 says that is the
signal something has leaked.

---

## 15. What this design does not decide

1. **The command descriptions and argument doc-strings** — they are prompt, not code, and REPO_SKELETON
   §11.5 leaves the persona's home open with a proposal (`packages/context/prompts/`, versioned, golden
   tested). The manifest assembly here reads them from wherever that lands.
2. **Whether consent for `read_screen` can be remembered for a match.** Per call by default (§5.4). A
   per-match grant is a product decision with a privacy consequence and needs a human call.
3. **Ownership of external API enrichment.** Inherited unsettled from state-capture §11.3, and this
   design adds a second consumer, which strengthens the case for its own package without settling it.
4. **Whether the retention policy drops command results first** (§8.2). Recommended here, owned by
   `packages/realtime`.
5. **Whether out-of-band responses (`response.conversation: "none"`, realtime §11.10) have a role.** They
   are the mechanism for screening without polluting conversation state, which might suit a cheap
   validation pass over a command result. Not proposed, not rejected — nobody has needed it yet.
6. **The composition root's home** (§9.3). `apps/desktop/src/main/agent/` is proposed; REPO_SKELETON §2.2
   does not cover it.
7. **Every number marked *(tunable)***, of which the turn deadline and the manifest ceiling matter most.
8. **Everything in §12.** Row 2 — whether multiple function calls can arrive per response — should be
   resolved before `queue.ts` is written, because it decides whether that file needs to exist.

---

## 16. Build order

`packages/context` is REPO_SKELETON §10 step 5, and the ports it needs land in steps 4, 7 and 8. The
order below keeps every step testable with the steps after it missing, which is the point of the port
seam:

1. `types.ts` + `contracts.ts` + `registry.ts` + `parse.ts` + `resolve.ts`, with `FakeToolPorts`. No
   world model required — the whole front half of the pipeline is Tier 1 against fixtures **today**.
2. `admission.ts` + `queue.ts` + `executor.ts` + the watchdog, still against fakes. The one-result
   property test exists from here on, which means every later handler inherits it.
3. `render.ts` + the golden corpus, sharing the snapshot renderer's primitives — do this with the Tier 2
   snapshot task rather than after it, or the two will diverge and never re-converge.
4. `model`-class handlers, as `packages/world-model` lands (step 4). Four of the eight commands, and no
   new infrastructure.
5. `reference`-class handlers + `ReferenceDataPort` with its patch-keyed cache.
6. `manifest.ts` + the ceiling test, once there is a real manifest to measure.
7. `ToolCallBridge` in the composition root, after `packages/realtime` (step 7). This is the first point
   at which anything here touches a session.
8. `observe` and `consequential` handlers, after the sidecar (step 8) and after the overlay's Confirming
   surface exists. `read_screen` lands last, because it is the only one that can do something a player
   would not expect.

Steps 1–3 are worth doing before the anti-cheat spike and before `packages/realtime` exists, because a
pipeline that is a pure function of a snapshot outlives every decision downstream of it.

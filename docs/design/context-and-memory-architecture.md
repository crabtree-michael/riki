# Context & Memory — Module & Class Architecture

**Status:** Draft / design proposal. No implementation exists; `packages/context` is the step-5 stub.
**Scope:** What the agent is given and what Riki remembers — Tier 1 session preamble assembly, the
Tier 2 rolling snapshot renderer, the shared rendering primitives both tiers use, and the memory
layer underneath all of it: the conversation ledger, coaching memory, the context-window retention
policy, and durable cross-match player memory. It is Tiers 1 and 2 of
[`dota2-state-capture-design.md`](dota2-state-capture-design.md) §6, plus a memory layer that
document does not have, and it lives in `packages/context/src/` per REPO_SKELETON.md §2.2.
**Reads with:** [`state-capture-architecture.md`](state-capture-architecture.md) §7 defines the read
interface this component consumes and should be read first.
[`agent-command-execution-architecture.md`](agent-command-execution-architecture.md) is Tier 3 in the
same package and shares this document's renderer (§5.1) and window budget (§7.1); its §8.2 hands
this document the retention question it declined to settle.
[`openai-realtime-research.md`](../research/openai-realtime-research.md) §1 and §5 supply the two
caps everything here is sized against.
**Out of scope:** Tier 3 command execution (same package, designed already), salience scoring and
the decision to speak (`packages/events`, dota2 §6.4), the Realtime wire protocol, session
lifecycle, and the mechanics of truncation (`packages/realtime` — this document owns the *policy*
and hands over a plan, §7), and fusion (`packages/world-model`).

---

## 0. Assumptions

Stated up front, house style. Sections marked ⚑ are what changes if one is wrong.

| # | Assumption | Source | Affects |
|---|---|---|---|
| K1 | **⚑ The model's context window is a lossy cache, not a record.** It truncates oldest-first, does not say what it dropped in a form we can query, and dies with the session | realtime §5 | ⚑ §6.2, ADR-0012 — the whole memory layer |
| K2 | **⚑ Session instructions and tool definitions share a 16,384-token cap and sit in the cached prefix.** The preamble is instructions, so it competes with the manifest | realtime §1, §5; ADR-0011 | ⚑ §4.2 |
| K3 | The practical conversation window is ~28,672 tokens after the prefix, and every truncation busts the prompt cache | realtime §5; tools §8.2 | §7 |
| K4 | The world model is the only source of game facts this component may read, and it already carries provenance, confidence and age | state-capture §3.2, §7.1 | ⚑ §5, §8.1 |
| K5 | Riki speaks roughly once a minute, and a match runs 35–45 minutes | dota2 §1, §6.4; ADR-0011 | §7.1 arithmetic |
| K6 | This document specifies interfaces, not implementations. No behaviour lands with it | house style (state-capture §0.4) | — |
| K7 | Numbers marked *(tunable)* are starting points to be measured. Numbers not so marked come from a design doc or from REPO_SKELETON | — | — |

**K1 is the one that decides what this component is.** Every other design in this repo has a place
to keep things: facts live in the world model, decisions live in the trigger policy, commands live
in the registry. What Riki has *said*, and what the player said back, has had nowhere to live except
the Realtime session's conversation — and that conversation is not a place. It truncates without
telling us, it cannot be enumerated, and when the session drops it is gone. A novelty gate built on
it would forget; a coach built on it would repeat itself after a reconnect and have nothing to say
after the match. So this component keeps its own record and treats the window as a cache of the tail
of it. That is ADR-0012, and §6.2 is its shape.

---

## 1. What this component is

`packages/world-model` knows what is true and has never heard of a turn. `packages/events` knows
whether now is a good time to speak and has never heard of a token. `packages/realtime` knows how to
hold a conversation and has never heard of a hero. Between them there is a component that has to
answer two questions on every turn — **what does the agent need to see right now**, and **what do we
already know that changes the answer** — and one question at the end of every match: **what was
worth keeping.**

Concretely it is four things:

1. **The preamble (Tier 1)** — assembled once at match start from the draft, external enrichment
   and durable player memory, then frozen into the cached prefix (§4).
2. **The snapshot (Tier 2)** — ~250–400 tokens rendered per turn from a `WorldSnapshot`, under a
   hard budget with priority-ordered truncation (§5).
3. **Memory** — four spans, from one turn to across matches, with the conversation ledger at the
   centre (§6).
4. **The window policy** — what should be in the model's context, expressed as a plan that
   `packages/realtime` executes (§7).

Tier 3, the command surface, is the same package and is already designed. It appears here twice:
it shares the rendering primitives (§5.1) and its results are the fastest-growing thing in the
window (§7.2).

### 1.1 Three tiers of context, four spans of memory

The tiers are dota2 §6's and are about *what the model sees*. The spans are this document's and are
about *what Riki keeps*. They are not the same axis, and conflating them is the mistake this
decomposition exists to prevent — the model seeing something is not Riki remembering it, and Riki
remembering something is not the model seeing it.

| Span | Lifetime | Holds | Where | Read by |
|---|---|---|---|---|
| **Working** | This turn and the next | The last rendered snapshot, the open turn, the current window estimate | RAM | The snapshot renderer (§5.3), the retention policy |
| **Ledger** | One match | Every turn: what triggered it, which snapshot went out, what was said either way, which commands ran | RAM; disk only under an opt-in debug flag (§6.5) | Retention, coaching memory, rehydration, post-match |
| **Coaching** | One match | Which advice topics have been raised, when, and whether the player acted | RAM — a projection of the ledger, not a second copy | `packages/events` novelty gate (§9.3) |
| **Durable** | Across matches | Typed observations about this player. No free text, by construction | Disk, local only | Preamble assembly (§4.1) |

**Coaching memory is to the ledger what derived state is to the world model** (state-capture §6): a
lazy projection, memoised against the source's version, never an independently mutated copy. That
parallel is deliberate — it is a pattern this repo has already committed to, and it answers the
question "what happens when the ledger is compacted" without inventing a second rule.

### 1.2 Non-goals

- **This component does not decide whether to speak.** `packages/events` does. It reads coaching
  memory to do it (§9.3), which is an edge in one direction only: memory informs the decision;
  memory does not make it.
- **This component does not truncate anything.** It computes a `WindowPlan` and hands it over.
  `packages/realtime` owns `conversation.item.truncate`, the retention ratio, and every other wire
  concern. The split is deliberate: policy is a pure function and belongs where it can be Tier 1
  tested, mechanism needs a session.
- **This component does not summarise with a model.** Summaries are *rendered* from structured data
  we already hold, not generated (§7.4). Riki is in the unusual position of having a complete
  structured record of the thing being summarised.
- **This component does not fuse, age, or gate facts.** It reads a `WorldSnapshot` and renders it.
- **This component does not store anything about other players.** §6.5 makes that structural rather
  than remembered.

---

## 2. The decomposition at a glance

```
   packages/world-model            packages/events              packages/realtime
   WorldModelReader (§8.1)         EventTapeReader (§8.2)       ContextWindowPort (§8.4)
          │                               │                          ▲       │
          │  snapshot() history()         │  recent events           │       │ transcripts,
          ▼                               ▼                   WindowPlan     ▼ turn open/close
┌───────────────────────────── packages/context/src ──────────────────────────────────────┐
│                                                                                          │
│   preamble/                    snapshot/                     memory/                     │
│   PreambleAssembler            SnapshotRenderer              WorkingMemory               │
│   EnrichmentPlanner            SectionSource ×N              ConversationLedger  ◄─┐     │
│   PrefixBudget                 PriorityLadder                CoachingMemory        │     │
│        │                            │                        RetentionPolicy       │     │
│        │                            │                        Compactor ────────────┘     │
│        │                            │                        Rehydrator                 │
│        │                            │                        PlayerMemoryStore          │
│        └────────────┬───────────────┴──────────────┬──────────────┘                     │
│                     ▼                              ▼                                     │
│                 render/  — the shared primitives (§5.1)                                  │
│                 SectionComposer · AgeFormatter · PrivacyGate · TokenCounter               │
│                     ▲                                                                    │
│                     │                                                                    │
│                 tools/   — Tier 3, designed separately, same renderer                    │
│                                                                                          │
│                 ContextAssembler — the one public surface (§9.4)                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                     │                                              │
                     ▼                                              ▼
              MemoryStore (§8.3)                            ReferenceDataPort
              local KV, injected                            (shared with tools/, §8.5)
```

Two properties make this modular rather than merely layered, both inherited from state-capture §2.1:

- **Nothing reaches sideways.** The snapshot renderer cannot see the ledger's raw entries; it sees
  `WorkingMemory`. Coaching memory cannot write to the ledger; it projects from it. The preamble
  cannot read the world model at all — it is assembled from the draft and from durable memory, and
  freezing it is what makes that restriction free.
- **The arrows are types.** A `WorldSnapshot` in, a `RenderedSnapshot` out, a `WindowPlan` over the
  edge. Every one of them can be a fixture, which is why almost all of §13 is Tier 1 today.

### 2.1 Directory layout

```
packages/context/src/
├── index.ts               the package surface
├── assembler.ts           ContextAssembler — the one runtime export (§9.4)
├── common/                the vocabulary and read interface every tier shares (§3.1, §8.1)
│   ├── types.ts           MonoMs, GameClock, TurnId, CallId, HeroId, Staleness, Observed<T>, …
│   └── ports.ts           WorldModelReader, WorldSnapshot, ContextTelemetry
├── render/                shared by every tier; land it first (§16)
│   ├── types.ts           RenderedText, Section, SectionId, Budget, TokenCounter, FieldClass
│   ├── contracts.ts       AgeFormatter, PrivacyGate, SectionComposer
│   ├── compose.ts         SectionComposer — budgeting and priority truncation
│   ├── age.ts             AgeFormatter — the one place a staleness becomes words
│   └── privacy.ts         PrivacyGate — the second of the two gates on chat text
├── preamble/
│   ├── types.ts           Preamble, PreambleSection, DraftView, PlayerIdentity, PrefixBudget
│   ├── contracts.ts       PreambleAssembler, EnrichmentPlanner
│   └── sections/          one file per section: draft, player, patch, benchmarks, persona
├── snapshot/
│   ├── types.ts           SnapshotContext, RenderedSnapshot, SnapshotSectionId
│   ├── contracts.ts       SnapshotRenderer, SectionSource, PriorityLadder
│   └── sections/          one file per line of the §5.2 format
├── memory/
│   ├── types.ts           LedgerEntry, LedgerRef, AdviceTopic, PlayerObservation, WindowPlan
│   ├── contracts.ts       ConversationLedger, WorkingMemory, CoachingMemory, RetentionPolicy,
│   │                      Compactor, Rehydrator, PlayerMemoryStore
│   └── ports.ts           MemoryStore, EventTapeReader, ContextWindowPort
├── tools/                 Tier 3 — already designed and scaffolded
├── prompts/               open question 5; the persona's home, if it lands here
└── testing/index.ts       FakeMemoryStore, FakeEventTape, fixed-clock and fixed-counter helpers
```

### 2.2 Why this split and not the obvious one

The obvious arrangement is a `ContextBuilder` class that reads the world model, formats a string,
and lets `packages/realtime` worry about the rest. Four things rule it out:

- **The renderer is not a pure function of the snapshot, and pretending it is hides a bug.** It
  needs to know what the model has already been told — for elision (§5.3), for the `recent:` tape,
  and for not repeating advice. That dependency is real; the only choice is whether it is a named
  module or an accreted set of fields on a builder.
- **The window is a shared resource with three claimants** — snapshot, command results, and
  conversation — growing at different rates, and only one of them replaces itself. Nobody can
  enforce a ceiling on a resource they can only see a third of, which is why §7 is a component and
  not a policy flag.
- **The memory layer outlives the session and the snapshot does not.** A reconnect throws away the
  conversation and keeps the ledger; a compaction throws away ledger entries from the window and
  keeps them in the ledger. Those two lifetimes cannot share an object.
- **Tier 3 already exists and already renders.** A second renderer with the same staleness rules
  written independently would drift, and the drift would be invisible until Riki hedged a fact in
  the snapshot and stated it flatly in a tool result. `render/` exists so there is one set of rules.
  `agent-command-execution-architecture.md` §16 step 3 asks for exactly this and warns that doing it
  afterwards means the two never re-converge.

The cost is indirection, plus one piece of tidying that the scaffold does immediately rather than
later. `tools/` landed first and declared its own `MonoMs`, `GameClock`, `TurnId`, `CallId`,
`HeroId`, `ItemId`, `Staleness`, `Observed<T>`, `PrivacyPolicy` and the world-model read interface,
because at the time it was the only tier. All three tiers speak about every one of those, so they
now live in `common/` and `tools/` re-exports them — one transitional declaration per type instead
of three, and therefore one edit when `@riki/protocol` and `@riki/world-model` land rather than
three (§11).

### 2.3 The boundary lints this design needs

Per REPO_SKELETON §6.2 and the `workspace` skill's first learning, these land **with the
implementation, not before** — a rule that fires on nothing cannot be verified, and each must be
proven by writing a violating file, running `pnpm exec eslint` on it, watching it fail, and deleting
it.

```js
// boundaries/external — the two that matter
{
  from: [['package', { name: 'context' }]],
  disallow: ['@riki/realtime', '@riki/events', '@riki/gsi', '@riki/log-tail', 'electron'],
  message:
    'packages/context reads through ports and speaks no vendor vocabulary. The event tape and ' +
    'the window arrive through ports the composition root wires; @riki/events depends on ' +
    'context, never the reverse.',
},
{
  from: [['package', { name: 'context' }]],
  disallow: ['node:fs', 'node:fs/promises', 'node:path', 'fs', 'path'],
  message:
    'packages/context does no I/O. Durable memory goes through MemoryStore, which the ' +
    'composition root implements with a path packages/config resolved.',
},
```

The second is the one that will actually catch something. Durable memory is the first thing in this
package that wants a file, and a single `await fs.writeFile` inside `PlayerMemoryStore` would make
the package untestable in a bare vitest process, put a path where `packages/config` cannot see it,
and give a privacy-relevant write no single audit point. `@riki/events` is in the first rule because
the dependency runs the other way (§9.3) and the natural mistake is to import the event type.

---

## 3. The vocabulary

These types are the contract, so they come first. They live in the `types.ts` of each subdirectory
and are scaffolded alongside this document.

### 3.1 Time and identity

`MonoMs`, `GameClock`, `TurnId`, `HeroId` and `ItemId` are already branded in `tools/types.ts` and
are used unchanged. They are declared there rather than in `@riki/protocol` only because that
package is step 2 and still empty; §11 records the collapse.

Two new ids:

```ts
/** A match. Durable memory is keyed by player, never by match; this is for the ledger only. */
export type MatchId = string & { readonly __brand: 'MatchId' };

/** A stable position in the ledger. Monotonic, so ordering is comparison, not lookup. */
export type LedgerRef = number & { readonly __brand: 'LedgerRef' };
```

### 3.2 Rendered text, and who counts tokens

Everything this component produces is text with a token cost attached, and the cost is load-bearing:
§4.2 and §7.1 are both budgets, and a budget enforced against a wrong number is not enforced.

```ts
export interface TokenCounter {
  /** Must never under-count. See the rule below. */
  count(text: string): number;
}

export interface RenderedText {
  readonly text: string;
  readonly tokens: number;
}

export interface Section {
  readonly id: SectionId;
  readonly priority: number;
  readonly body: RenderedText;
  /** Sections at or below this may be dropped whole; above it, never (§5.2). */
  readonly droppable: boolean;
}
```

> **The counter is injected, and a counter that estimates must over-count.**

An exact count needs a tokenizer, which is a dependency this package should not carry and which
`packages/realtime` may already have. So it is a port. The direction of the estimator's error is a
design decision, not an implementation detail: an over-count wastes headroom, which costs a few
tokens per turn; an under-count silently exceeds a cap, which is discovered as an API error
mid-match or, worse, as the API truncating something we believed was safe. A Tier 1 test asserts
`estimate(text) >= exact(text)` across the golden corpus, which is the only place we have both
numbers.

### 3.3 The ledger entry

One closed union, and the closure is the point — §6.5's privacy guarantees are properties of this
type, not of the code that writes it.

```ts
export type LedgerEntry =
  | { readonly kind: 'turn_opened';   readonly turnId: TurnId; readonly cause: TurnCause;
      readonly at: MonoMs; readonly clock: GameClock | null }
  | { readonly kind: 'snapshot';      readonly turnId: TurnId; readonly rendered: RenderedText;
      readonly sections: readonly SectionId[]; readonly at: MonoMs }
  | { readonly kind: 'agent_said';    readonly turnId: TurnId; readonly transcript: string;
      readonly topics: readonly AdviceTopic[]; readonly at: MonoMs }
  | { readonly kind: 'player_said';   readonly turnId: TurnId; readonly transcript: string;
      readonly at: MonoMs }
  | { readonly kind: 'command';       readonly turnId: TurnId; readonly callId: CallId;
      readonly name: string; readonly result: RenderedText; readonly status: string;
      readonly at: MonoMs }
  | { readonly kind: 'summary';       readonly replaces: readonly LedgerRef[];
      readonly rendered: RenderedText; readonly at: MonoMs }
  | { readonly kind: 'turn_closed';   readonly turnId: TurnId; readonly at: MonoMs;
      readonly outcome: 'spoke' | 'silent' | 'cancelled' };

export type TurnCause =
  | { readonly by: 'player'; readonly gesture: 'push_to_talk' | 'wake' }
  | { readonly by: 'trigger'; readonly event: EventId; readonly salience: number }
  | { readonly by: 'system'; readonly reason: 'match_started' | 'rehydrate' };
```

`turn_closed` carrying `'silent'` is not bookkeeping. `packages/events` decides not to speak far
more often than it decides to speak (dota2 §6.4), and the record of a suppressed trigger is what
lets the cooldown and novelty gates reason about *pressure* rather than only about utterances — and
what makes "Riki has been quiet for nine minutes" a thing anybody can notice.

`agent_said.topics` comes from the trigger, not from the text (§6.3). Nothing in this component
classifies natural language.

---

## 4. Tier 1 — the preamble

### 4.1 Assembly

```ts
export interface PreambleAssembler {
  /**
   * Called once, on match_started, before the session opens. Total: enrichment failures are
   * recorded in `degraded`, never thrown, because a preamble that fails is a match with no coach.
   */
  assemble(input: PreambleInput, deadline: MonoMs): Promise<Preamble>;
}

export interface PreambleInput {
  readonly matchId: MatchId;
  readonly draft: DraftView;          // ten heroes, from the world model at match_started
  readonly player: PlayerIdentity;    // hero, role, lane, rank bracket
  readonly patch: string;
  readonly memory: PlayerMemory;      // durable, §6.4 — may be empty
}

export interface Preamble {
  readonly text: string;
  readonly tokens: number;
  readonly frozenAt: MonoMs;
  /** Per-section, so the §4.2 budget is a sum of visible parts rather than one opaque number. */
  readonly sections: readonly PreambleSection[];
  /** Enrichment that did not arrive in time. Present in telemetry, absent from the text. */
  readonly degraded: readonly PreambleSectionId[];
}

export type PreambleSectionId =
  | 'persona' | 'player' | 'draft' | 'matchups' | 'patch_notes' | 'benchmarks' | 'history';
```

The sections are dota2 §6.1's list. Two of them are ours rather than the external API's: `history`
is durable memory (§6.4) rendered as a handful of lines about how this player has played this hero
*with Riki*, and `persona` is REPO_SKELETON §11.5's open question — assembled from wherever the
prompt files land, counted here either way.

### 4.2 The prefix budget nobody was tracking

The preamble goes into `session.update` instructions. ADR-0011 established that tool definitions
share a **16,384-token cap** with those instructions (realtime §1). Two documents have since sized
their half of that cap independently, and no test sums them:

| Part | Budget *(tunable)* | Owned by |
|---|---|---|
| Persona and speaking rules | 1,200 | REPO_SKELETON §11.5 — open |
| Preamble: player, draft, matchups, patch, benchmarks, history | 1,500 | This document, §4.1 |
| Tool manifest | 2,000 | ADR-0011 |
| **Committed** | **4,700** | |
| Headroom | 11,684 | |

The headroom is comfortable, and saying so is more useful than implying tightness that does not
exist. What matters is the missing arithmetic: **three growing things share one cap and no single
place adds them up.** `PrefixBudget` is that place, and it is one Tier 1 assertion:

```ts
export interface PrefixBudget {
  readonly capTokens: number;                       // 16,384, from realtime §1
  readonly parts: ReadonlyMap<string, number>;      // persona, preamble sections, manifest
  total(): number;
  /** Fails the build, not the match: this is knowable before a session exists. */
  check(): { readonly ok: boolean; readonly overBy: number };
}
```

The reason to have it before it binds: the preamble is the part that grows without anyone deciding
to grow it. Matchup notes for ten heroes, patch notes, build benchmarks and a player history are all
"one more line per hero", and ten heroes times a few lines is how 1,500 becomes 4,000 without a
commit that looks like it did anything.

### 4.3 Enrichment is best-effort, and the deadline is short

External API data (dota2 §2.4) is fetched at draft time through the same `ReferenceDataPort` Tier 3
uses (§8.5). It is best-effort with a hard deadline *(tunable: 3,000 ms, running concurrently with
the draft)*, and a section that misses it is dropped, not waited for.

```ts
export interface EnrichmentPlanner {
  /** What to fetch for this draft, in priority order, so a deadline truncates the tail. */
  plan(draft: DraftView, player: PlayerIdentity): readonly EnrichmentRequest[];
}
```

The alternative — block match start until enrichment lands — is worse than it looks. The draft is
roughly 90 seconds and the loading screen is another 60; a slow or down OpenDota would make Riki
silent through the laning phase, which is the phase where the advice is most valuable and most
time-critical. A coach with no matchup notes is still a coach.

Priority order matters for the same reason: the player's own hero benchmark is worth more than the
fifth enemy's matchup note, so it goes first and the tail is what a deadline eats.

### 4.4 Freezing, and the two things that invalidate it

The preamble is immutable for the match (dota2 §6.1), for ADR-0011's reason: it is the cached prefix,
and a change rewrites it. Two events legitimately invalidate it, and both are handled by building a
new session rather than by editing this one:

- **A reconnect** (§7.5) — the preamble is re-assembled and must be byte-identical, or the new
  session pays for a prefix it could have cached. `assemble()` is therefore a pure function of
  `PreambleInput`, and the input is retained for the match. A Tier 1 test asserts the identity.
- **A new match.** Everything resets except durable memory.

Notably *not* invalidating it: the draft changing after a backfill, a player abandoning, or the
degradation level. If a hero swap after the horn makes the preamble wrong, the snapshot corrects it
within one turn — a wrong line in the prefix costs less than a rewritten prefix.

---

## 5. Tier 2 — the snapshot

### 5.1 The renderer, and the primitives it shares with Tier 3

```ts
export interface SnapshotRenderer {
  /** Pure, synchronous, and budgeted at <5 ms (dota2 §6, `agent-context` skill). */
  render(world: WorldSnapshot, ctx: SnapshotContext): RenderedSnapshot;
}

export interface SnapshotContext {
  readonly turnId: TurnId;
  readonly now: MonoMs;
  readonly cause: TurnCause;
  readonly budget: Budget;
  readonly privacy: PrivacyPolicy;
  readonly tape: readonly TapeEvent[];        // from EventTapeReader, §8.2
  readonly working: WorkingMemory;            // the elision base and what was already said
}

export interface RenderedSnapshot extends RenderedText {
  readonly turnId: TurnId;
  readonly sections: readonly Section[];
  readonly truncated: boolean;
  /** What the budget or the confidence gate dropped. Telemetry, and asserted by golden tests. */
  readonly omitted: readonly SectionId[];
}
```

Three primitives live in `render/` and are used by both this and the Tier 3 result renderer:

```ts
/** The one place a staleness becomes words. "4s ago(0.91)", "~12s ago", "unseen >20s". */
export interface AgeFormatter {
  format(observed: Observed<unknown>, now: MonoMs, clock: GameClock | null): string;
}

/** The second of two independent gates on chat text; the first is at the source (state-capture §4.2). */
export interface PrivacyGate {
  allow(field: FieldClass, policy: PrivacyPolicy): boolean;
  redact(text: string, policy: PrivacyPolicy): string;
}

/** Assembles sections under a ceiling, dropping by priority and recording what went. */
export interface SectionComposer {
  compose(sections: readonly Section[], budget: Budget): {
    readonly text: string;
    readonly tokens: number;
    readonly omitted: readonly SectionId[];
  };
}
```

`AgeFormatter` being shared is the substantive one. dota2 §4 rule 3 and §6.2 both say a stale CV
fact renders with its age and confidence or not at all, and that rule is enforced by *there being
one function that turns an `Observed<T>` into a string*. Two of them, written months apart, would
agree until the day one of them learned to say "probably".

### 5.2 Sections and the truncation ladder

The format is dota2 §6.2's, one section per line group. What is new here is that the order is
declared data rather than the order of statements in a function:

| # | Section | Droppable | Why it sits here |
|---|---|---|---|
| 1 | `header` — clock, daytime, self hero/level/hp/mp/position | **never** | The model cannot hedge without knowing when "now" is |
| 2 | `self_economy` — gold, net worth, KDA, last hits, gpm | **never** | dota2 §6.2: self-state is never truncated |
| 3 | `self_abilities` | **never** | Cooldowns are the highest-frequency correct advice |
| 4 | `self_items` | **never** | |
| 5 | `enemies` — level, alive/dead, respawn | **never** | dota2 §6.2: enemy state is never truncated |
| 6 | `seen` — last-known positions with age and confidence | yes | The first thing that is a hypothesis rather than a fact |
| 7 | `unseen` — heroes not observed for >20 s | yes | Drops *with* `seen`, never separately (see below) |
| 8 | `derived` — buy timings, rune and Roshan windows, net-worth lead | yes | Pre-computed arithmetic; valuable but reconstructible via `get_timings` |
| 9 | `map` — towers, barracks | yes | Slow-moving; the model can ask |
| 10 | `recent` — the event tape | yes, first | dota2 §6.2 names history as the first thing to go |

Two rules that are not obvious from the table:

- **`seen` and `unseen` drop together.** `unseen >20s: ws, zeus` is only meaningful against the list
  of who *was* seen; alone it reads as a complete account of the enemy team's whereabouts, which is
  the opposite of what it says. A truncation that leaves one without the other is worse than
  dropping both.
- **The cause of the turn promotes exactly one section.** If `TurnCause` is a trigger for
  `rune_soon`, `derived` moves above `seen`; for `enemy_missing`, `seen` moves to the top of the
  droppable group. One promotion, chosen by a lookup table from `EventId` to `SectionId`, so the
  ordering stays a golden-testable fact rather than a scoring function. The turn exists because of
  that event; the section that explains it should not be what the budget eats.

### 5.3 Elision, and why it is specified but off

dota2 §6.2 asks for elision: *"Elide what didn't change when consecutive turns are close together,
but never elide silently — a `(unchanged)` marker is fine, a missing field is not."* Designing
against §7 turned up that this is a coupling, not a formatting choice, and the arithmetic is closer
than it looks.

An elided snapshot is a delta against a base, and **a delta is only meaningful while its base is
still in the window.** The retention policy (§7.2) drops superseded snapshots, so the base is
exactly the kind of thing retention wants to remove. That makes elision a keyframe-and-delta scheme:
periodic full snapshots, deltas in between, and no compaction may cut a chain in the middle.

The saving is real between compactions — roughly 120 tokens per turn on a 300-token snapshot
*(estimated)*, so ten turns of chain costs ~1,900 tokens instead of ~3,000. The cost is that a delta
whose base is gone is a snapshot that says `(unchanged)` about a value the model cannot see, and
realtime §11.6 documents what the model does with information it needs and does not have: it
supplies it. That failure is silent, it is in the tier that carries self-state, and it depends on our
*estimate* of what is in the window being right — which §12 lists as unverified.

So: **the mechanism is specified and the default is off.**

```ts
export interface ElisionBase {
  readonly ref: LedgerRef;
  readonly rendered: RenderedSnapshot;
  /** The base's game clock, rendered into the marker so a broken chain is visible, not silent. */
  readonly clock: GameClock | null;
}
```

And one improvement to dota2 §6.2's marker regardless of the default: `(unchanged since 14:12)`
rather than `(unchanged)`. A bare marker is unfalsifiable — the model cannot tell a working chain
from a broken one. A marker carrying its base's clock time means a model whose base was truncated
sees a reference to a time it has no record of, which is at least a question it can ask.

Turn elision on when §12's window-belief reconciliation has been measured, not before.

### 5.4 The 5 ms budget

Model → snapshot is budgeted under 5 ms (dota2 §6, the `agent-context` skill). The renderer is
called once per turn, so this is not hot code; the budget exists because the alternative is doing
game arithmetic in the renderer, which would put it on the wrong side of the world model's boundary.

Three rules keep it structural rather than aspirational:

- **No arithmetic in a section.** `buy: diffusal2 in ~40s` is `DerivedView`'s number, formatted. If
  a section wants a calculation, that is a `packages/world-model` change (state-capture §9), one
  derived rule, memoised per version.
- **Token counts are memoised per section body**, keyed by the string. Sections that did not change
  do not get recounted, which matters because counting is the only per-character work here.
- **The tape is read, not scanned.** `EventTapeReader` returns the last N events already ordered
  (§8.2); the renderer does not filter a match's history.

---

## 6. Memory

### 6.1 Working memory

The smallest span, and the only one the renderer touches directly.

```ts
export interface WorkingMemory {
  /** The elision base, if elision is on and the base is still believed to be in the window. */
  elisionBase(): ElisionBase | null;
  /** Advice already given this match, for the "you already know" suppression in §6.3. */
  raised(topic: AdviceTopic): AdviceRecord | undefined;
  /** Our belief about window occupancy, maintained by the Compactor and reconciled in §7.6. */
  window(): WindowState;
  noteRendered(snapshot: RenderedSnapshot, ref: LedgerRef): void;
  noteTurnClosed(turnId: TurnId, outcome: 'spoke' | 'silent' | 'cancelled'): void;
}
```

It holds no history of its own. Every method above is a lookup into the ledger or a cached
projection of it — which is what makes "what happens to working memory at compaction" a question
with an answer (§7.3) rather than a bug.

### 6.2 The conversation ledger — ADR-0012

```ts
export interface ConversationLedger {
  readonly matchId: MatchId;
  append(entry: LedgerEntry): LedgerRef;
  /** Everything since a ref, in order. The projection primitive. */
  since(ref: LedgerRef): readonly LedgerEntry[];
  entry(ref: LedgerRef): LedgerEntry | undefined;
  /** Refs we believe the model can currently see. Maintained against the WindowPlan. */
  inWindow(): readonly LedgerRef[];
  /** Called when realtime confirms what it actually dropped. Reconciliation, §7.6. */
  markDropped(refs: readonly LedgerRef[], reason: DropReason): void;
  /** Monotonic; projections memoise against it, exactly as derived state does (state-capture §6). */
  version(): number;
}

export type DropReason = 'planned' | 'api_truncation' | 'session_lost';
```

Append-only, in memory, one per match. The whole match is a few hundred entries and a few tens of
kilobytes of text — it is not a data structure that needs care.

**Why it exists at all**, since the session already holds a conversation (ADR-0012 carries the full
argument):

1. **The window truncates oldest-first and does not tell us what it dropped** (realtime §5). A
   novelty gate over a memory that silently forgets will re-raise advice, which dota2 §6.4 names as
   the failure most likely to make Riki annoying enough to uninstall.
2. **A session that drops loses everything.** Riki's window fills in a normal match (§7.1) and the
   API has a 60-minute session cap; a long game reaches both. Reconnect is not an edge case, and
   without a ledger a reconnected Riki repeats every piece of advice it already gave.
3. **The record is text and structure; the window is mostly audio.** Ours is roughly two orders of
   magnitude smaller and costs nothing to keep for the match.
4. **Post-match review needs it**, and nothing else in the architecture holds "what Riki said".

### 6.3 Coaching memory

A projection over the ledger, memoised against `version()`.

```ts
/** Closed: a topic is an event type or a subject, never free text. */
export type AdviceTopic =
  | { readonly of: 'event'; readonly event: EventId }
  | { readonly of: 'item'; readonly item: ItemId }
  | { readonly of: 'hero'; readonly hero: HeroId }
  | { readonly of: 'objective'; readonly objective: 'roshan' | 'tower' | 'rune' | 'stack' };

export interface AdviceRecord {
  readonly topic: AdviceTopic;
  readonly firstAt: GameClock;
  readonly lastAt: GameClock;
  readonly count: number;
  readonly response: AdviceResponse;
}

export type AdviceResponse = 'unknown' | 'followed' | 'ignored' | 'dismissed';

export interface CoachingMemory {
  recent(topic: AdviceTopic, within: number): AdviceRecord | undefined;
  all(): readonly AdviceRecord[];
  /** Derived from the world model, not from the conversation. See below. */
  observeOutcome(record: AdviceRecord, world: WorldSnapshot, now: MonoMs): AdviceResponse;
}
```

Two decisions carry this:

**Topics come from the trigger, never from the text.** When `packages/events` fires
`can_afford_key_item` and Riki speaks, the topic is that event — recorded on `turn_opened` before a
word is spoken. Nothing here classifies natural language, which means no model in the loop, no
drift, and a deterministic novelty gate. The imprecision is accepted and worth naming: Riki may be
triggered by one thing and talk about another, and the record will be wrong. A player-initiated turn
has no topic at all, correctly — the player asked, and answering the same question twice is what a
coach should do.

**Whether advice was followed is observed in the world model, not inferred from the conversation.**
If Riki said "you can afford a BKB" and a BKB appears in the inventory within *(tunable: 90 s)*,
that is `followed`. If the gold was spent elsewhere, `ignored`. The player saying "yeah okay" is
worth nothing; the item is worth everything. This is the one place this component looks at the world
model for something other than rendering, and it is what makes durable memory (§6.4) more than a
game count.

### 6.4 Durable player memory — ADR-0013

Across matches, on disk, and deliberately the most constrained thing in this document.

```ts
/** Closed union with no free-text field anywhere in it. That is the privacy guarantee (§6.5). */
export type PlayerObservation =
  | { readonly kind: 'hero_played'; readonly hero: HeroId; readonly role: Role;
      readonly result: 'win' | 'loss' | 'unknown'; readonly at: number }
  | { readonly kind: 'advice_response'; readonly topic: AdviceTopic;
      readonly response: AdviceResponse; readonly at: number }
  | { readonly kind: 'pattern'; readonly pattern: PatternId; readonly at: number }
  | { readonly kind: 'preference'; readonly key: PreferenceKey; readonly value: string };

export interface PlayerMemory {
  readonly schemaVersion: number;
  readonly heroes: ReadonlyMap<HeroId, HeroFamiliarity>;
  readonly adviceTendency: ReadonlyMap<string, AdviceTendency>;
  readonly patterns: readonly PatternCount[];
}

export interface PlayerMemoryStore {
  /** Total: a missing, corrupt or version-mismatched file yields an empty memory, never an error. */
  load(): Promise<PlayerMemory>;
  record(observation: PlayerObservation): void;
  /** Batched. Called at match end and on a slow timer, never per observation. */
  flush(): Promise<void>;
  /** One settings button, one call. */
  forget(): Promise<void>;
}
```

What it buys, and why it is worth a persistence surface at all: dota2 §6.1 puts "hero comfort/history"
in the preamble and dota2 §2.4 sources it from OpenDota. That is the player's *match history*, which
is public and coarse. What Riki can know and OpenDota cannot is how this player responds to *this
coach* — that they act on ward advice and ignore rune reminders, that they die to the same rotation
in three matches out of four. That is the difference between a coach and a stats site, and it is
three lines in the preamble.

Rules, all structural:

- **No free text.** The union above has no `string` field that is not an id or an enum. Chat, voice
  transcripts, player names and model output are not representable, so they cannot be written by
  mistake.
- **The local player only.** There is no key for anyone else. Teammates and opponents appear in
  observations as hero ids, which are not people.
- **Version and discard.** `schemaVersion` mismatch or a parse failure yields an empty memory and a
  telemetry line. Best-effort migration is allowed; a failed migration must discard rather than
  guess. Nothing here is load-bearing — Riki works completely without it, which is what makes
  discarding the right default.
- **`RIKI_MEMORY=off` disables it**, resolved by `packages/config` like every other setting, and the
  store degrades to an in-memory no-op rather than a branch at every call site.

### 6.5 What persists, and what does not

| | Persists | Default | Why |
|---|---|---|---|
| Durable player memory | Yes, local disk | on | Typed observations, no free text, no third parties (§6.4) |
| The conversation ledger | **No** | off | It contains the player's own voice transcript and possibly chat |
| Ledger, under `RIKI_LEDGER_PERSIST` | Yes, local disk | **off** | Debug and post-match review; same treatment dota2 §7 gives debug frame capture |
| Rendered snapshots | No | — | Reconstructible from the world model's ring history |
| Anything about other players | **Never** | — | Not representable (§6.4), which is stronger than not written |

The ledger's default is the interesting row. It holds the most useful post-match artifact in the
system and also the only free text in the component, including — if the player has enabled chat
ingestion at all — other people's words. dota2 §7 already decided the shape of this trade for raw
frames: off by default, a clearly-labelled local directory, automatic expiry, a visible indicator.
This follows it rather than inventing a second policy, and post-match review ships behind the same
flag until someone decides otherwise (§15).

All paths come from `packages/config`. This package never picks one, never reads `process.env`, and
never touches `node:fs` — §8.3's `MemoryStore` is a four-method key/value port, and §2.3's second
lint rule is what keeps it that way.

---

## 7. The context window — policy here, mechanism in `packages/realtime`

### 7.1 The budget, and why compaction is normal rather than exceptional

realtime §5 sizes a naive session at 15–20 minutes before the window fills, on the basis of
continuous conversation: assistant audio at 1,200 tokens/minute, user audio at 600. Riki is not a
continuous conversation — it is invisible until needed — so that arithmetic does not transfer, and
redoing it for Riki's usage pattern produces a different and more awkward number.

Estimated, per minute of match, with Riki speaking about ten seconds in a minute and the player five
*(K5, and all of these are estimates — §12)*:

| Contributor | Tokens/min | Note |
|---|---|---|
| Assistant audio | ~200 | 1,200/min × 10 s |
| User audio | ~50 | 600/min × 5 s |
| **Snapshot** | **~300** | One per turn, ~300 tokens, and it does *not* replace itself in history |
| **Command results** | **~200** | tools §8.2 budgets up to 600/turn; this is a working average |
| Total | **~750** | |

Against ~28,672 usable (K3), that is **roughly 38 minutes to the first compaction** — which lands
squarely inside a normal Dota match. Two conclusions follow, and both are the reason §7 exists:

- **Compaction is a normal event, not a failure path.** Any match that goes long will compact, and
  a compaction that is discovered rather than planned busts the cache at a moment nobody chose.
- **Riki's own context injection dominates the window, not the conversation.** Snapshot plus command
  results is ~500 of the ~750 tokens per minute. The thing to economise is not what Riki says; it is
  what we tell it. That inverts the intuition realtime §5 leaves you with, and it is why the
  retention ladder (§7.2) drops our own artifacts first and conversation last.

### 7.2 The retention ladder

```ts
export interface RetentionPolicy {
  /** Pure. Given what we believe is in the window and a budget, what should leave. */
  plan(ledger: ConversationLedger, budget: WindowBudget, now: MonoMs): WindowPlan;
}

export interface WindowBudget {
  readonly capTokens: number;          // K3, ~28,672
  readonly lowWaterMark: number;       // compact when occupancy crosses this (tunable: 0.75)
  readonly targetAfter: number;        // compact down to this (tunable: 0.55) — realtime §5
  readonly keepLastTurns: number;      // never dropped (tunable: 6)
}

export interface WindowPlan {
  readonly drop: readonly LedgerRef[];
  readonly replace: readonly { readonly refs: readonly LedgerRef[]; readonly with: RenderedText }[];
  readonly estimatedTokensAfter: number;
  readonly reason: 'low_water' | 'quiet_moment' | 'forced';
}
```

Drop order, least-valuable first:

1. **Command results older than the current turn.** `agent-command-execution-architecture.md` §8.2
   recommended exactly this and left the call to `packages/realtime`; this document is the policy
   owner and settles it. A stale answer to a question about a fight that ended ten minutes ago has
   no residual value, while the conversation around it does.
2. **The tool *calls* whose results were dropped, always in the same plan.** Dropping a result and
   keeping the call leaves the model looking at a question it asked and never got an answer to,
   which is the vacuum tools §7.4 exists to prevent — reintroduced by the retention policy. Drop the
   pair or neither. This is the rule most likely to be got wrong by an implementation that treats
   entries as independent.
3. **Superseded snapshots** — every one but the most recent. A ten-minute-old snapshot describes a
   game that no longer exists. It is self-labelling, because dota2 §6.2's format leads with
   `T 14:32`, and that header is what makes an uncompacted history merely wasteful rather than
   actively misleading — but it is still 300 tokens saying nothing.
4. **Old conversation turns, replaced by a rolled summary** (§7.4).
5. **Never dropped:** the preamble and the manifest (they are the cached prefix — removing them
   costs everything and saves nothing), the most recent snapshot, and the last `keepLastTurns` turns
   of conversation.

### 7.3 When to compact

Not when the window is full. realtime §5's guidance is to trim aggressively but rarely, because
every truncation busts the prompt cache; and the cache bust is a latency cost, which means it lands
on the player as a slow answer.

So compaction has a low-water mark *(0.75)* and a preference for a quiet moment. "Quiet" is
available without a new dependency: the world model's derived state already knows about teamfight
intensity — it is the same signal `packages/events` uses to suppress speech during a fight (dota2
§6.4) — and this component already reads the world model.

```ts
export interface Compactor {
  /** Called on turn close. Cheap and usually a no-op. */
  consider(world: WorldSnapshot, now: MonoMs): WindowPlan | null;
  /** Applied after realtime confirms execution; updates inWindow() and the elision base. */
  applied(plan: WindowPlan, dropped: readonly LedgerRef[]): void;
}
```

Above the low-water mark, `consider` returns a plan at the first quiet turn. Above the cap it
returns one regardless — `reason: 'forced'` — because a cache bust during a fight is still better
than the API truncating oldest-first, which would take the preamble.

That last point is worth stating plainly: **oldest-first truncation removes the cached prefix.**
Whatever we do, we must reach the budget before the API does, or Riki loses its persona and its
match context and keeps its most recent small talk.

### 7.4 Summaries are rendered, not generated

The obvious way to compact a conversation is to ask a model to summarise it. Riki should not,
because Riki is in an unusual position: **the thing being summarised is already structured.** The
world model holds the kills, the objectives, the item timings and the net-worth curve; the ledger
holds every piece of advice given and whether it was followed. A summary of the first twenty minutes
of a Dota match is a template over data we already have.

```ts
export interface SummaryRenderer {
  /** Deterministic. Same ledger and same world history render the same text. */
  render(entries: readonly LedgerEntry[], world: WorldModelReader, budget: Budget): RenderedText;
}
```

That buys four things a generated summary does not: it costs no tokens and no latency, it cannot
hallucinate a kill that did not happen, it is golden-testable as a diff like every other format in
this package, and it works when the session is already unhealthy — which is exactly when compaction
tends to be needed.

The one thing it does not capture is the *texture* of the conversation: what the player was worried
about, how they asked. The design keeps that as topic labels rather than prose, which is lossy and
accepted. If it ever needs to be better, the mechanism is an out-of-band response
(`response.conversation: "none"`, realtime §11.10) — which tools §15.5 already flagged as a
capability with no current use. That is the use, and it is listed as open (§15) rather than built.

### 7.5 Reconnect and rehydration

A dropped or expired session is a normal event in a long match (§6.2 reason 2). The ledger is what
makes recovery possible:

```
session lost ──► preamble re-assembled from the retained PreambleInput (byte-identical, §4.4)
             ──► Rehydrator.brief(ledger, world) ──► one system item:
                    · the match summary so far      (§7.4's renderer, same code)
                    · advice already given, by topic (so Riki does not repeat itself)
                    · the last few turns' gist
             ──► current snapshot rendered fresh
             ──► the agent continues
```

```ts
export interface Rehydrator {
  brief(ledger: ConversationLedger, world: WorldSnapshot, budget: Budget): RenderedText;
}
```

Two rules: **audio is never replayed** — the brief is text, and the recorded transcripts are the
record. And **the player is told.** A coach that silently forgets the last twenty minutes and then
confidently repeats itself is worse than one that says "lost you for a second — where were we". The
brief exists so that sentence is not necessary, but the honesty rule from dota2 §9 applies: degrade
loudly to the developer, quietly to the user, and never silently into wrongness.

### 7.6 What we believe versus what is true

Everything in §7 rests on an estimate of window occupancy — our token counter, our model of what the
API kept. That estimate can drift, and if it drifts far enough the elision base (§5.3) and the
"keep the last six turns" guarantee both become wrong.

Two cheap corrections, and both are why `markDropped` exists:

- **`rate_limits.updated` and usage reporting** give a real number per turn (realtime §6). The
  difference between it and `WindowState.estimatedTokens` is a drift metric, and a Tier 4 assertion
  over a replayed session is where it gets caught.
- **If the API truncates before we do**, `packages/realtime` reports it and the ledger records
  `DropReason.api_truncation`. A non-zero count of those is a bug in this component, not a condition
  — it means the low-water mark or the counter is wrong, and it should alert exactly like tools
  §7.1's `internal` row.

---

## 8. The ports

Five, and nothing in this component reaches past them.

### 8.1 `WorldModelReader` — every game fact, one way in

state-capture §7.1, imported unchanged, exactly as Tier 3 imports it: `snapshot(now)`,
`onVersion(listener)`, `history(since)`. No source is read directly, so every CV fact reaches the
agent through precedence, the confidence gate and ageing exactly once.

`history(since)` is used by two things here that Tier 3 does not need: the `recent:` section's
fallback when the event tape is unavailable, and the summary renderer (§7.4).

### 8.2 `EventTapeReader` — the `recent:` line

```ts
export interface EventTapeReader {
  /** The last n typed events, newest last, already salience-ordered by packages/events. */
  recent(n: number, since: GameClock | null): readonly TapeEvent[];
}

export interface TapeEvent {
  readonly id: EventId;
  readonly at: GameClock;
  /** Already natural language, from packages/events (dota2 §6.4). This component does not phrase events. */
  readonly text: string;
}
```

The direction here is the one to get right. dota2 §3's architecture diagram has the event engine
feeding the context builder, and `packages/events` is the package that decides what an event *is*
and how it reads. So the tape arrives through a port this component declares and that package
implements, wired in the composition root — which keeps `packages/context` free of any import of
`@riki/events` (§2.3) while the data flows the way the diagram says. The reverse edge, events
reading coaching memory, is a plain import (§9.3).

### 8.3 `MemoryStore` — the only thing resembling I/O

```ts
export interface MemoryStore {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
}
```

Four methods, no paths, no `fs`. The composition root implements it against a directory
`packages/config` resolved. `FakeMemoryStore` is a `Map`, which is what makes every durable-memory
test Tier 1.

### 8.4 `ContextWindowPort` — the seam with `packages/realtime`

```ts
export interface ContextWindowPort {
  /** Executed by packages/realtime: truncations, deletions, and the summary item. */
  apply(plan: WindowPlan): Promise<AppliedWindowPlan>;
  /** Reported back so §7.6 can reconcile. Includes truncations the API did on its own. */
  onDropped(listener: (refs: readonly LedgerRef[], reason: DropReason) => void): Unsubscribe;
  /** Real usage, when the session reports it. Null when unknown; never guessed. */
  usage(): WindowUsage | null;
}
```

The division: this component decides *what should not be in the window and what should replace it*;
`packages/realtime` decides *how to make that true* — `conversation.item.truncate`, the retention
ratio, item ids, and the order of operations. Neither half is testable in the other's terms, which
is why they are separate packages and why the plan is a value rather than a series of calls.

### 8.5 `ReferenceDataPort` — shared with Tier 3

The same port `agent-command-execution-architecture.md` §5.3 declares, used here for draft
enrichment. That document noted external API enrichment has no owner in REPO_SKELETON §2.2 and that
having two consumers strengthens the case for its own package without settling it. This document is
the second consumer and does not settle it either — but it does add a requirement: **the cache must
be warm-able before a session**, because §4.3's 3-second deadline is otherwise a coin flip on a cold
cache. Patch-keyed and pre-fetched at app start, not at draft.

---

## 9. Integration

### 9.1 Every counterpart, in one table

If a row is not here, this component does not talk to it.

| Counterpart | Direction | Carried by | What flows |
|---|---|---|---|
| `packages/world-model` | in | `WorldModelReader` | `snapshot()`, `onVersion()`, `history()` |
| `packages/events` | in | `EventTapeReader` (port, wired at the root) | The `recent:` tape |
| `packages/events` | in | `TurnBrief` on `openTurn` | Why this turn exists, and its salience |
| `packages/events` | out | `CoachingMemoryReader` (plain import, events → context) | Advice already given, and whether it landed (§9.3) |
| `packages/realtime` | out | `ContextWindowPort.apply` | The `WindowPlan` |
| `packages/realtime` | in | `ContextWindowPort.onDropped`, `usage` | What was actually dropped; real token usage |
| `packages/realtime` | in | composition root adapter | Transcripts → `agent_said` / `player_said`; session lost → rehydrate |
| `packages/context/src/tools` | — | in-package | Shares `render/`; its results are `command` ledger entries |
| External APIs | out | `ReferenceDataPort` | Draft enrichment; patch-keyed disk cache |
| `packages/config` | in | injected | `RIKI_MEMORY`, `RIKI_LEDGER_PERSIST`, privacy flags, tunables, the memory directory |
| `packages/telemetry` | out | `ContextTelemetry` | Render latency, token spend by tier, compaction count, drift (§7.6) |
| `apps/desktop` overlay | — | — | **No edge.** Captions are the renderer's problem, not the context builder's |

### 9.2 One turn, end to end

```
events decides to speak ──► ContextAssembler.openTurn(TurnBrief)
                                    │
                              WorkingMemory + EventTapeReader + WorldModelReader.snapshot()
                                    │
                              SnapshotRenderer.render()  ── <5 ms ──►  RenderedSnapshot
                                    │                                        │
                              ledger.append({kind:'snapshot'})               ▼
                                    │                              handed to the session
                                    ▼
                       agent speaks; may issue commands (Tier 3)
                                    │
                       transcripts + command results ──► ledger.append()
                                    │
                       ContextAssembler.closeTurn()
                                    │
                       Compactor.consider() ──► WindowPlan or null
                                    │
                       ContextWindowPort.apply() ──► realtime executes ──► ledger.markDropped()
```

The compaction check is at turn *close*, never at turn open. At open it would add latency to the
path the 100 ms and 5 ms budgets are protecting; at close there is no one waiting.

### 9.3 The events seam, and which way the import points

`packages/events` needs two things this component holds: whether a piece of advice has already been
given (dota2 §6.4's novelty gate — *"don't repeat advice the player already acted on, or that they
ignored twice"*), and whether Riki has been silent for a long time.

The dependency runs **events → context**, as a plain type import of a read-only interface:

```ts
/** What packages/events may see. No mutation, no ledger, no tokens. */
export interface CoachingMemoryReader {
  recent(topic: AdviceTopic, within: number): AdviceRecord | undefined;
  lastSpokeAt(): GameClock | null;
  silentFor(now: GameClock): number;
}
```

The alternative — coaching memory living in `packages/events` — was rejected because the record is a
projection of the ledger, and moving the projection away from its source means two copies of "what
Riki said", diverging the first time a compaction or a reconnect touches one of them.

The reverse edge, the event tape, is dependency-inverted through §8.2's port precisely so this stays
a one-way import and the dependency graph stays a DAG: `world-model → context → events`.

Note what does *not* cross: `packages/events` never sees a token count, a window state, or a
`LedgerEntry`. `CoachingMemoryReader` is three methods about advice. Giving the salience path a
reason to know about tokens is the same inversion tools §9.1 refused for commands.

### 9.4 The public surface and the composition root

```ts
/** The whole of what this package exports at runtime. */
export interface ContextAssembler {
  /** Tier 1. Called once; the result is frozen for the match (§4.4). */
  openSession(input: PreambleInput, deadline: MonoMs): Promise<SessionContext>;
  /** Tier 2. Synchronous, budgeted, and the hot path. */
  openTurn(brief: TurnBrief, now: MonoMs): TurnContext;
  closeTurn(turnId: TurnId, outcome: TurnOutcome, now: MonoMs): void;
  /** For packages/events. Read-only (§9.3). */
  readonly coaching: CoachingMemoryReader;
  /** For the session adapter: transcripts in, plans out. */
  readonly ledger: ConversationLedgerWriter;
  rehydrate(now: MonoMs): Promise<RenderedText>;
}

export interface SessionContext {
  readonly preamble: Preamble;
  readonly manifest: ToolManifest;      // from tools/, assembled by the same root
  readonly prefix: PrefixBudget;        // §4.2 — the sum nobody was adding up
}
```

Wiring lives in `apps/desktop/src/main/agent/`, the directory
`agent-command-execution-architecture.md` §9.3 proposed for the tool surface and flagged as an
ownership gap in REPO_SKELETON §2.2. This component belongs in the same root — it is the other half
of the same subsystem, it shares the `ReferenceDataPort` and the prefix budget with it, and
splitting them would mean two roots that have to agree about the 16,384-token cap.

---

## 10. Failure modes

The dota2 §9 table, for this component. Every row degrades loudly to the developer, quietly to the
player, and never silently into wrongness.

| Failure | Detected by | Response |
|---|---|---|
| Enrichment API slow or down at draft | §4.3 deadline | Preamble ships without those sections; `degraded` records which; match starts on time |
| Durable memory file missing, corrupt, or a version behind | `PlayerMemoryStore.load` | Empty memory, telemetry line, no error. Riki works fully without it |
| World model has no snapshot yet (pre-horn) | `WorldSnapshot.clock === null` | Draft-phase snapshot: draft and timings only. Never an empty string |
| GSI silent, snapshot requested | Staleness on the facts | Fields render with age; `expired` fields absent rather than guessed (dota2 §4 rule 2) |
| CV confidence collapse | The world model already suppresses (state-capture §9) | `seen` and `unseen` drop together (§5.2); the snapshot says less rather than something wrong |
| Event tape unavailable | `EventTapeReader` absent or empty | `recent:` omitted. It is the first droppable section anyway |
| Snapshot over budget | `SectionComposer` | Priority truncation; `omitted` recorded; the five never-droppable sections always survive |
| Token counter under-counts | §12 drift check, and §7.6's reconciliation | Alerts. The counter contract (§3.2) is that this cannot happen |
| Window fills faster than modelled | `lowWaterMark` crossed | Compaction at the next quiet turn; `forced` if the cap is reached first |
| API truncated before we did | `onDropped(reason: 'api_truncation')` | Reconcile `inWindow()`, disable elision, alert. A non-zero count is a bug, not a condition |
| Session lost mid-match | `packages/realtime` | Rehydrate from the ledger (§7.5); preamble re-assembled byte-identical; the player is told |
| Elision base dropped | `WorkingMemory.elisionBase()` returns null | Next snapshot is full. This is why the base is a lookup and not a cached string |
| Match ends mid-turn | `closeTurn` never arrives | Ledger sealed at match end; durable observations flushed; working memory discarded |
| Ledger grows unexpectedly | Entry count on `closeTurn` | Bounded by turns, which are bounded by the cooldown gates. If this ever fires, `packages/events` is misbehaving |

---

## 11. Module boundaries

| Boundary | Rule | Held by |
|---|---|---|
| `packages/context` → `packages/realtime` | Forbidden | Lint to add (§2.3) — the plan crosses as a value |
| `packages/context` → `packages/events` | Forbidden | Lint to add — the tape arrives through a port; the import runs the other way |
| `packages/context` → `packages/gsi`, `log-tail` | Forbidden | Lint to add — facts arrive only via `WorldModelReader` |
| `packages/context` → `node:fs`, `node:path` | Forbidden | Lint to add (§2.3) — `MemoryStore` is the seam |
| `packages/context` → `apps/*` | Forbidden | Existing rule (§6.2) |
| `packages/events` → `packages/context` | **Allowed**, types only, `CoachingMemoryReader` | §9.3 — deliberate, and the only edge |
| `process.env` | Only `packages/config` | Existing rule |
| `console.*` | Only `packages/telemetry` | Existing rule — hence `ContextTelemetry` as a port |

Everything transitional now sits in `common/`, which is the point of that directory: when
`@riki/protocol` (step 2) and `@riki/world-model` (step 4) land, `common/types.ts` and
`common/ports.ts` become re-export shims and then disappear. `MonoMs`, `GameClock`, `TurnId`,
`CallId`, `MatchId`, `HeroId` and `ItemId` belong to the first; `WorldSnapshot`, `WorldDelta`,
`WorldModelReader`, `Staleness` and `Observed<T>` to the second. `tools/` re-exports the ones its
own architecture document names, so those references stay valid without a second declaration.

None of that is a design position. It is a consequence of writing three tiers before step 2, and it
should be cleaned up rather than preserved.

---

## 12. Claims to verify before building on them

House style: what has been read versus what has been measured. None of the following has been
measured on this project, and three of them would change the design.

| Claim | How to check | Consequence if wrong |
|---|---|---|
| **⚑ The per-minute window arithmetic in §7.1** — that Riki's own context injection outweighs conversation audio, giving ~38 minutes to first compaction | Token-count a replayed match's turns against real usage reporting | ⚑ If compaction is rare, §7.3's quiet-moment machinery is over-engineering; if it is much sooner, the snapshot budget has to shrink |
| **⚑ Our estimate of what is in the window tracks reality** | Compare `WindowState.estimatedTokens` against `rate_limits.updated` over a long replayed session | ⚑ Elision (§5.3) stays off permanently, and `keepLastTurns` becomes a hope |
| **⚑ Deleting a mid-conversation item busts the cache the same way truncation does** | Compare cached-input billing across a compaction | ⚑ §7.3's batching and quiet-moment preference lose their reason; compact eagerly instead |
| A session can be re-established mid-match without the player noticing more than a beat | Kill a session against a fixture and time the rehydrate path | The rehydrate brief gets smaller, or reconnect becomes a spoken event rather than a silent one |
| Command results are billed as input on every later turn until dropped | Cost accounting over a long replayed session | Inherited unverified from tools §12; it is why they are first on the ladder |
| A conservative token estimator is within ~10% of exact | Tokenize the golden corpus both ways | The counter becomes a real dependency in `packages/realtime` rather than a port with a cheap default |
| Elision saves ~120 tokens on a ~300-token snapshot | Render the golden corpus both ways | The §5.3 trade changes sign; it is currently marginal |

The first row is the one to check first, because it is cheap — it needs a fixture and a tokenizer,
not a live session — and because everything in §7 is sized against it.

---

## 13. Testing map

Tiers are REPO_SKELETON §5.3. The decomposition exists so that almost all of it is Tier 1, testable
today against fakes with no game, no session, and no network.

| Unit | Tier | Asserts |
|---|---|---|
| `AgeFormatter` | 1 | Every `Staleness` renders age and confidence; **no path produces a bare value** — the dota2 §4 rule, in one test |
| `SectionComposer` | 1 | Priority order; the five never-droppable sections survive any budget; `omitted` is complete |
| `seen`/`unseen` pairing | 1 | A budget that drops one drops both (§5.2) |
| Cause-driven promotion | 1 | Each `EventId` in the table promotes its section and nothing else |
| `TokenCounter` contract | 1 | Estimator never under-counts across the golden corpus (§3.2) |
| `PrefixBudget` | 1 | persona + preamble + manifest ≤ 16,384 (§4.2). **The sum nobody was computing** |
| `PreambleAssembler` | 1 | Byte-identical for identical input (§4.4); a failed enrichment degrades a section, not the preamble |
| Enrichment deadline | 1 | A port that never resolves still produces a preamble within the deadline |
| `ConversationLedger` | 1 | Append/since/version; `markDropped` updates `inWindow` without mutating entries |
| `CoachingMemory` | 1 | Projection memoises against `version()`; compaction does not change any `AdviceRecord` |
| `RetentionPolicy` | 1 | The §7.2 ladder in order; **a dropped result always drops its call**; never-dropped set is never dropped |
| `Compactor` | 1 | No plan below the low-water mark; quiet-moment preference; `forced` above the cap |
| `SummaryRenderer` | 1 | Deterministic for identical ledger + world history |
| `Rehydrator` | 1 | Brief contains every advice topic already raised — the "does not repeat itself" property |
| `PlayerMemoryStore` | 1 | Corrupt, absent and version-mismatched files all yield empty memory, never an error |
| **Durable memory privacy** | 1 | **Egress test**: no `PlayerObservation` can carry free text; a ledger full of chat produces a `PlayerMemory` containing none of it |
| Snapshot privacy gate | 1 | With default config, chat text never appears in a rendered snapshot (dota2 §7) |
| Rendered snapshots | 2 | Golden, `fixtures/golden/snapshot/` — the format is the interface to the LLM, so it is a diff |
| Rendered summaries and briefs | 2 | Golden, same corpus |
| Snapshot latency | 4 | Replayed match: model → snapshot < 5 ms at p99 (dota2 §6) |
| Window arithmetic | 4 | Replayed 45-minute match: estimated occupancy tracks reported usage; compaction fires once; no `api_truncation` |
| Reconnect | 4 | `FakeRealtimeTransport` drops the session mid-match; assert the preamble is byte-identical and no advice topic is repeated |

Three deserve their emphasis. **The `AgeFormatter` test** is the executable form of dota2 §4 rule 3
and the only one that guards it across both tiers. **The `PrefixBudget` test** is the one that
catches a class of change — "one more line per hero" — that no reviewer notices. **The durable
memory privacy test** is the one that cannot be walked back once it fails in the field, and it is
nearly free because the guarantee is structural: the test is that the union has no free-text arm.

---

## 14. Extensibility

What each change costs. If one of these is expensive, the boundaries are wrong.

**Add a line to the snapshot** — one file in `snapshot/sections/`, one entry in the priority ladder,
one golden diff. The ladder entry is the part not to skip: a section with no declared priority is a
section that truncates in whatever order the array happened to be in.

**Change how something reads** — `render/` and a golden diff, and it changes both tiers at once.
This is the change that will happen most often, because it is prompt engineering by another name,
and it is deliberately the cheapest.

**Add a preamble section** — one file, one `PreambleSectionId`, one enrichment request if it needs
data, and a re-measure of §4.2. The re-measure is the whole point of having the budget object.

**Add a durable observation kind** — one arm on the `PlayerObservation` union, a `schemaVersion`
bump, and a projection into `PlayerMemory`. The closed union means the privacy test re-runs itself:
a new arm with a `string` field that is not an id fails it.

**Change the retention ladder** — `RetentionPolicy` alone. It is a pure function of the ledger and a
budget, which is why it is a policy object and not a set of conditions inside a compaction loop.

**A snapshot line that needs data the world model does not have** — that is a
`packages/world-model` change (a derived rule, one file, per state-capture §9), not a change here.
If it seems to need a change to *fusion*, the model is being asked to know it is feeding an LLM, and
state-capture §7.3 says that is the signal something has leaked.

**Summaries that need a model** — that is the out-of-band response mechanism (§7.4), and it is a new
port, not a change to `SummaryRenderer`. Deliberately expensive, because the deterministic version
should have to lose an argument first.

---

## 15. What this design does not decide

1. **Whether post-match review ships at all**, and therefore whether `RIKI_LEDGER_PERSIST` becomes
   a user-facing feature rather than a debug flag (§6.5). It is a product decision with a privacy
   consequence: the ledger holds the player's own voice transcript.
2. **Whether durable memory should be on by default.** This design says yes, on the grounds that the
   closed union makes it structurally incapable of holding what dota2 §7 protects. But REPO_SKELETON
   §7.2's rule is that privacy-relevant defaults are off, and "Riki writes a file about how you
   play" is the kind of thing a person should be told once even if the file is harmless. The
   first-run consent flow is where that lands. **A human should confirm this one.**
3. **Where the persona lives** — REPO_SKELETON §11.5, still open. §4.2 counts it either way.
4. **Ownership of external API enrichment.** Inherited unsettled from state-capture §11.3 and
   tools §15.3; this is the third consumer and it adds a requirement (§8.5) without settling it.
5. **Whether the out-of-band response has a role** in summarisation (§7.4). Same open question as
   tools §15.5, now with a concrete candidate use.
6. **Every number marked *(tunable)***, of which the low-water mark, `keepLastTurns` and the
   enrichment deadline matter most.
7. **Everything in §12**, and the first row decides how much of §7 needs to exist.

---

## 16. Build order

`packages/context` is REPO_SKELETON §10 step 5, and the ports it needs land in steps 4, 7 and 8. The
order below keeps every step testable with the steps after it missing, which is the point of the
port seam. It interleaves with `agent-command-execution-architecture.md` §16 rather than following
it — steps 1 and 2 here are that document's step 3.

1. **`render/`** — `AgeFormatter`, `SectionComposer`, `PrivacyGate`. Nothing else can land first
   without duplicating the staleness rules, and tools §16 step 3 warns that two renderers written
   apart never re-converge. The shared-vocabulary half of this is already done: `common/` exists and
   `tools/` re-exports from it (§2.2).
2. **`snapshot/`** against `fixtures/gsi/` and a fake world model, with the golden corpus. This is
   the deliverable of REPO_SKELETON §10 step 5 and the thing that makes the format iterable.
3. **`memory/` — the ledger, `WorkingMemory`, `CoachingMemory`.** No session required: append
   entries from a fixture and assert the projections. `packages/events` can build its novelty gate
   against this before `packages/realtime` exists.
4. **`RetentionPolicy` + `SummaryRenderer` + `Compactor`**, still with no session. All three are pure
   functions of a ledger and a budget, and §12's first row should be measured here, before the
   numbers they use are load-bearing.
5. **`preamble/` + `PrefixBudget`**, once there is a manifest to add to it (tools §16 step 6).
6. **`PlayerMemoryStore`** against `FakeMemoryStore`, with the privacy test from day one.
7. **`ContextWindowPort` and the session adapter** in the composition root, after `packages/realtime`
   (step 7). This is the first point at which anything here touches a session, and the first at
   which §7.6's reconciliation can run.
8. **`Rehydrator`**, last, because it is the only piece that cannot be exercised at all without a
   session that can be made to drop.

Steps 1–4 are worth doing before `packages/realtime` exists, because a renderer and a retention
policy that are pure functions of a snapshot and a ledger outlive every decision downstream of them.

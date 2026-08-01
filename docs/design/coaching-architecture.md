# Proactive Coaching — Deletion Plan & Module Architecture

**Status:** Spec / architecture proposal, for review. **No implementation lands with this document.**
Every change it describes belongs to a follow-up ticket; §16 is the ticket list.
**Scope:** Two halves of one decision. First, the complete removal of the agent command execution
system — Tier 3 of [`dota2-state-capture-design.md`](dota2-state-capture-design.md) §6.3, the
`packages/context/src/tools/` pipeline, its seam in `packages/realtime`, and the two overlay states
that exist only to serve it. Second, the module that replaces it: a **proactive coaching** path in
which Riki volunteers advice rather than waiting to be asked, fed by state capture and by the
context/memory layer that already exists.
**Reads with:** [`context-and-memory-architecture.md`](context-and-memory-architecture.md) — the
memory layer, the rendering primitives and the window budget are all reused unchanged, and its §7.1
arithmetic is re-derived here. [`state-capture-architecture.md`](state-capture-architecture.md) §7
is still the only way a game fact reaches this component. `dota2-state-capture-design.md` §6.4 is
the trigger policy this document builds out.
[`agent-command-execution-architecture.md`](agent-command-execution-architecture.md) is the
document being deleted; §2.6 says what happens to it.
**Out of scope:** The persona text itself (§7.4 gives the one-line default and routes the rest to
open question 5), the wire protocol and session lifecycle (`packages/realtime`), fusion
(`packages/world-model`), and the salience *scoring function* — §6.2 gives its shape and inputs and
deliberately does not give its coefficients.

> **⚠ Read this first: the trigger half is being built in parallel.**
>
> While this document was being written, another agent began implementing `packages/events` — the
> trigger half of coaching — against a sibling document, `coaching-trigger-architecture.md`. That
> work is further along and more detailed than §6 here, and **where the two disagree, it wins.**
>
> The split of ownership that results is clean, and it is the one §4.1 argues for on independent
> grounds:
>
> | Half | Owner | Spec |
> |---|---|---|
> | **Deletion** — what goes, in what order, and what must be salvaged first | This document, §2–§3 | Here. Unclaimed elsewhere |
> | **Trigger** — detection, salience, the gates, suppression accounting | `packages/events`, in flight | `coaching-trigger-architecture.md` |
> | **Content** — the coaching brief: what the model is shown for a given moment | `packages/context/src/coaching/` | This document, §4–§5. Unclaimed elsewhere |
> | **Routing** — voice intents and the overlay after the deletion | This document, §7 | Here |
>
> §6 is therefore kept deliberately thin and defers throughout; §6.6 lists the four places the
> in-flight design is ahead of it, including one seam gap that needs closing before the two halves
> meet. Every trigger-side interface named below is *theirs*, quoted for context, not proposed here.

---

## 0. Assumptions

Stated up front, house style. Sections marked ⚑ are what changes if one is wrong.

| # | Assumption | Source | Affects |
|---|---|---|---|
| P1 | **⚑ The command system is deleted, not repurposed.** No handler, registry, queue or manifest survives in another form | Ticket, answer 1 | ⚑ §2 — the whole deletion inventory |
| P2 | **⚑ Coaching is proactive.** Riki volunteers advice; the player asking is the secondary path, not the primary one | Ticket, answer 2 | ⚑ §6, and the risk in §3.2 |
| P3 | Riki's voice is clear, concise and encouraging. Tuning it further is a separate piece of work | Ticket, answer 3 | §7.4 |
| P4 | ADR-0003 still holds: Riki observes and never acts inside the game | ADR-0003, not open for re-litigation | §2.3 — deleting `read_screen` makes it *more* true |
| P5 | The world model is the only source of game facts this component may read, and it already carries provenance, confidence and age | state-capture §3.2, §7.1 | ⚑ §5 |
| P6 | The memory layer — ledger, coaching memory, retention, durable memory — is built and stays | context-and-memory §0, §6; ADR-0012, ADR-0013 | §5.2, §8 |
| P7 | This document specifies interfaces, not implementations. No behaviour lands with it | house style (state-capture §0.4) | — |
| P8 | Numbers marked *(tunable)* are starting points to be measured | — | — |

**P1 and P2 together are one inversion, and it is the only idea in this document.** The command
system was built on a *pull* model: the snapshot stays small, and when the agent needs detail it
asks. Coaching is *push*: something in the game becomes worth saying, and Riki assembles exactly
the detail that thing needs and speaks. Everything in §2 follows from deleting the pull half, and
everything in §4–§6 is the push half.

Two smaller consequences of P1 that are easy to miss and are called out where they land: the tool
manifest was 2,000 tokens of the cached prefix (§8.1), and command results were the
fastest-growing claimant on the conversation window (§8.2). Deleting them changes both budgets in
the same direction.

---

## 1. What this changes

`packages/world-model` knows what is true. `packages/context` knows what the model should see and
what Riki has already said. `packages/realtime` knows how to hold a conversation. Between them
there has always been a gap that `packages/events` was supposed to fill — *is now a moment worth
speaking about, and about what* — and it has never been built. `packages/events` is an empty stub
with a doc comment.

That is worth naming plainly, because it changes how large this work looks:

> **Most of the "new coaching module" is the package that was always going to exist and never got
> built.** dota2 §6.4 already specifies event detection, salience, cooldowns, the novelty gate and
> the intensity suppression. The genuinely new part is small: a **coaching brief** — a focused,
> budgeted rendering of the facts a specific piece of advice needs — which is what fills the hole
> the tool pipeline leaves behind.

So the shape is:

```
                    BEFORE (pull)                              AFTER (push)

  world model ──► snapshot (~300 tok, general)      world model ──► snapshot (~300 tok, general)
                        │                                                │
                  agent reads it                                   events detects a
                        │                                          coachable moment
                  "I need detail"                                        │
                        │                                          brief assembled for
              function_call ──► pipeline ──► ports                 *that* moment (~150 tok)
                        │        (parse, admit, queue,                   │
                  result (~40–300 tok)  execute, render)           agent speaks once
                        │                                                │
                  agent speaks                                    ledger + coaching memory
```

The agent stops being an interrogator and becomes a speaker. Nothing crosses a process boundary to
answer a question, nothing has a 1,200 ms turn deadline, and nothing needs a watchdog to guarantee
that every call gets exactly one reply.

---

## 2. What gets deleted

This section is an inventory, not a plan of attack — the ordering that makes the deletion land
without a red test suite is §16 step 1. Line counts are from the tree as it stands.

### 2.1 `packages/context/src/tools/` — the pipeline, entire

Roughly **5,460 lines across 31 files.** Every one of them goes:

| Group | Files |
|---|---|
| Pipeline | `parse.ts`, `codec.ts`, `resolve.ts`, `admission.ts`, `queue.ts`, `executor.ts`, `breaker.ts`, `fresh.ts`, `turn.ts`, `render.ts`, `surface.ts` |
| Registry & manifest | `registry.ts`, `manifest.ts`, `all-handlers.ts`, `tunables.ts`, `failures.ts`, `aliases.ts` |
| Handlers | all eight of `handlers/` — `get-enemy-detail`, `get-timings`, `get-recent-events`, `get-minimap-summary`, `get-item-info`, `get-matchup-advice`, `get-build-benchmark`, `read-screen` |
| Vocabulary | `types.ts`, `contracts.ts`, `index.ts` |
| Tests | `pipeline.test.ts`, `executor.test.ts`, `egress.test.ts`, `handlers/handlers.test.ts` |

Two notes on things that look salvageable and are not.

`tools/render.ts` composes `render/`'s three primitives into a Tier-3-shaped result — a list of
labelled parts under a per-command ceiling. The coaching brief needs something structurally
similar, and it should still be **written fresh** rather than renamed: a brief's parts are keyed by
advice topic and ordered by what the trigger cares about, not by a command's argument list, and
retrofitting the old shape would carry a per-command budget concept into a component that has no
commands. `render/` itself — `AgeFormatter`, `PrivacyGate`, `SectionComposer`, `TokenCounter` — is
untouched and is what actually gets reused.

`tools/aliases.ts` (`HERO_BY_SPOKEN`, `ITEM_BY_SPOKEN`, `normalise`) exists so a *tool argument*
saying "sf" resolves to a hero in this match. With no tool arguments there is nothing to resolve:
the model speaks hero names, it does not send them. It goes, and if player-initiated Q&A later
needs subject grounding it comes back out of git history rather than being carried dead.

### 2.2 What must be salvaged first — the trap in this deletion

> **None of what follows is part of the command execution system, and none of it is being kept,
> repurposed, or run alongside the replacement.** The pipeline, the registry, the manifest, the
> queue, the executor, the handlers, the effect classes and the failure taxonomy are deleted
> outright and in full (§2.1). What §2.2 moves is four pieces of **pre-existing shared
> infrastructure that happen to be declared inside the `tools/` directory**, because Tier 3 landed
> first and was the only tier at the time — `context-and-memory-architecture.md` §2.2 records that
> history and had already begun undoing it by moving the shared vocabulary into `common/`.
>
> The test for each is the same: *does anything other than a command use it today?* All four
> answer yes, and none of them mentions a call, an argument, a deadline or a tool.

**`packages/context/src/tools/` is not a leaf.** Four things inside it are imported by the rest of
the package, and one of them is imported by every test file in it. Deleting the directory before
moving them turns the whole package red at once, which is the worst possible position from which
to work out what was load-bearing.

| What | Who needs it | Where it goes |
|---|---|---|
| `tools/testing/index.ts` — `FakeWorldModel`, `observed`, `FakeReferenceData`, `ManualTimers`, `FactSpec`, `FakeWorldOptions` | **Every test in the package**: `snapshot/*.test.ts`, `memory/*.test.ts`, `preamble/preamble.test.ts`, `assembler.test.ts`, and `src/testing/index.ts` re-exports them | `packages/context/src/testing/index.ts`, which already re-exports them and becomes their home. `FakeToolPorts` is the only member that dies |
| `tools/ports.ts` — `ReferenceDataPort`, `ItemInfo`, `MatchupNote`, `BuildBenchmark` | `preamble/assemble.ts`, `preamble/sections/index.ts` — draft enrichment | `common/ports.ts`, alongside `WorldModelReader` |
| `tools/ports.ts` — `CapturePort` | `crates/riki-vision`, at the other end. It is **owned by `state-capture-architecture.md` §4.3** and declared here only as a structural mirror, which the file's own header says | `common/ports.ts` — returning a borrowed declaration, not salvaging one. §5.3 |
| `tools/timers.ts` — `Timers`, `systemTimers` | `preamble/assemble.ts` (the enrichment deadline) | `common/timers.ts` |
| `tools/contracts.ts` — `ToolManifest` | `assembler.ts` (`SessionContext.manifest`, `ContextAssemblerDeps.manifest`) | Deleted outright; see §2.5 |

The move is mechanical and should be **its own commit, landing green**, before a single file is
removed. §16 step 1 says so and it is the one sequencing instruction in this document that is not
negotiable.

### 2.3 `read_screen`, consent, and the one consequential thing Riki did

`read_screen` was the only member of the `consequential` effect class: the only operation in the
product that sent anything off the machine that was not audio, the only one that needed a consent
prompt, the only one rate-limited for privacy rather than for cost, and the only reason the overlay
has a `Confirming` state.

Deleting it removes, in one move:

- The `ConsentPort`, `ConsentRequest`, `ConsentDecision` and `ConsequentialActivity` vocabulary.
- `ToolCallPort.resolveConsent` in `packages/realtime/src/session.ts`.
- The overlay's `Confirming` phase, `ConfirmPrompt`, the `confirm-timeout` timer, the scoped `Y`/`N`/`Esc`
  accelerator grab (`Effect.keys`), the `confirm` overlay intent, the `confirm` affordance and accent
  token, and `VoiceCommand.consent`.
- **The protocol change that was never made.** `agent-command-execution-architecture.md` §11 flagged
  `ConsentRequest` as the one type in that design that would eventually have to move into
  `packages/protocol` as a zod schema and become a coordination event. It never moved —
  `packages/protocol` is still step 2 and still empty — so there is no generated Rust, no contract
  fixture and no cross-language shape to unwind. The deletion is cheaper than the design doc's own
  §11 makes it sound, and it *closes* open question 9 ("may consent for `read_screen` be remembered
  for a match?") by removing the thing it was about.

This is the part of the deletion with the clearest product argument independent of coaching: it
makes ADR-0003 structurally true rather than true by policy. After it, nothing Riki does needs a
permission prompt.

### 2.4 `packages/realtime` — the seam, not the session

The tool surface reaches further into `packages/realtime` than the ownership map suggests. All of
this goes:

| File | What |
|---|---|
| `src/session.ts` | `ToolCallPort` (the interface and the `deps.tools` field), `dispatchTool()`, the `response.function_call_arguments.done` case that calls it, the `function_call_output` item creation and its follow-up `response.create`, `resolveConsent` |
| `src/session-config.ts` | `ToolManifestEntry`, `SessionConfig.tools`, the `tools:` mapping and `tool_choice: 'auto'` in the payload builder |
| `src/types.ts` | `CallId`, the `{ kind: 'tool' }` arm of the session event union |
| `src/wire.ts` | The `response.function_call_arguments.done` parse branch and its `call_id` field |
| `src/testing/index.ts`, `fixtures/realtime/` | `tool-call-with-consent.jsonl` and its entry in `REQUIRED_FIXTURES` |
| `test/session.test.ts`, `src/wire.test.ts`, `src/session-config.test.ts` | The tool-dispatch and manifest assertions |

**One thing stays, deliberately.** The session config should keep sending an explicit `tools: []`
rather than omitting the field, and the wire parser should keep exactly one branch for
`response.function_call_arguments.done` — which **counts it in telemetry and ignores it, and never
dispatches or replies.** The reasoning is `openai-realtime-research.md` §11.6: the model has been
observed narrating tool calls it did not make and leaking call arguments into speech. A model that
is told it has no tools should never emit one; if it does, we want a counter that says so rather
than an unhandled event. This is about six lines and it is the difference between a deletion and a
blind spot.

### 2.5 `packages/context` outside `tools/`

- **`src/index.ts`** — drop `export * from './tools/index.js'`.
- **`assembler.ts`** — `SessionContext.manifest` and `ContextAssemblerDeps.manifest` go; `PrefixBudget`
  loses its `manifest` part (§8.1); `TurnContext.remaining` and `turnResultTokens` are re-aimed at
  the coaching brief rather than at command results (§8.2).
- **`memory/types.ts`** — the `command` arm of `LedgerEntry` goes, and with it `CallId` from
  `common/types.ts`. A `brief` arm replaces it (§5.2): the brief is injected context, exactly like a
  snapshot, and retention has to be able to see it.
- **`memory/retention.ts`** — rungs 1 and 2 of the §7.2 ladder go. Rung 2 was *"the tool calls whose
  results were dropped, always in the same plan"*, which context-and-memory §7.2 calls "the rule most
  likely to be got wrong by an implementation that treats entries as independent". Deleting the pairing
  rule removes the only place in the retention policy where dropping one entry obliges dropping
  another. The ladder becomes: superseded briefs → superseded snapshots → old conversation turns,
  replaced by a rolled summary → never-dropped set.

### 2.6 Docs, ADRs and open questions

**`docs/design/agent-command-execution-architecture.md` is deleted, and this document takes its slot
in the corpus.** It is cross-referenced from `docs/README.md`, `context-and-memory-architecture.md`
(a dozen times), `state-capture-architecture.md`, `voice-input-architecture.md`, three ADRs and two
skills. Deleting it without a link sweep leaves a dozen dangling relative links that
`markdownlint` will not catch. The sweep is part of the same ticket, and where a reference is to
reasoning that still applies — the total-function rule, the degrade-to-a-marked-answer table — the
link should be re-pointed here rather than dropped.

**Three ADRs are superseded, not deleted.** REPO_SKELETON §3 is explicit that a reversal gets
recorded through the `Status` field rather than by removing the page:

| ADR | Fate |
|---|---|
| [0011](../adr/0011-tool-manifest-frozen-per-session.md) — command manifest frozen per session | Superseded. There is no manifest |
| [0018](../adr/0018-argument-schemas-from-a-local-declaration.md) — argument schemas from a local declaration | Superseded. There are no arguments |
| [0019](../adr/0019-get-build-benchmark-is-reference-class.md) — `get_build_benchmark` is a `reference` command | Superseded. There are no commands. The *fact* it records — that benchmark data comes from `ReferenceDataPort` and cannot answer inside 20 ms — survives as a brief-assembly constraint (§5.3) |

They are marked Superseded by the ADR that accompanies this document, **when that ADR moves from
Proposed to Accepted** — that is, by the deletion ticket, not by this one.

Unaffected and worth saying so: **ADR-0003** (read-only observation) is strengthened;
**ADR-0012** (the conversation ledger is ours) becomes more load-bearing, since the ledger is now
the only record of what advice was given; **ADR-0013** (durable memory is typed observations) is
untouched and is what makes coaching improve across matches; **ADR-0021** (speech is costed as
audio) is untouched.

Open questions in `docs/README.md` move as follows:

| # | Question | After |
|---|---|---|
| 9 | May consent for `read_screen` be remembered for a match? | **Closed.** There is no `read_screen` |
| 10 | Can the Realtime API emit more than one function call per response? | **Closed.** It decided whether `queue.ts` needed to exist; it does not exist |
| 5 | Where does the agent's persona live? | **More urgent.** With no tool descriptions, the preamble persona is the only thing shaping how Riki sounds (§7.4) |
| 11 | Does Riki's own context injection dominate the window? | **Changed inputs.** Command results were ~200 of the ~750 tokens/min; §8.2 re-derives it |

### 2.7 What does *not* get deleted

Worth listing explicitly, because two of these look like command execution and are not:

- **`LocalCommand` parsing** (`packages/realtime/src/commands.ts`, voice-input §6.2–§6.3) — `stop`,
  `mute`, `quiet-mode`, `cancel`. These were never tool calls; they are a four-member closed union
  parsed locally from a transcript so that they work when the model is unavailable. §7.1 explains
  why they matter *more* after this change, not less.
- **The `CapturePort`** — the sidecar control channel (`requestRegion`, `setRegionSchedule`,
  `recalibrate`). It belongs to state-capture §4.3 and was only *used* by two commands; the wrapper
  those commands used, `FreshCaptureRequest`, is command machinery and is deleted (§5.3).
- **`ReferenceDataPort`** — external item, matchup and benchmark data. Two of its three consumers
  were commands; the third, preamble enrichment, is the one that survives and it keeps the port.
- The entire memory layer, the snapshot renderer, `render/`, the preamble, and the world model.

---

## 3. What the deletion buys, and what it costs

House rule from dota2 §9 applied to a design decision rather than a failure: state the bad parts.

### 3.1 What it buys

- **2,000 tokens of cached prefix**, back into a 16,384-token cap that three growing things share
  (§8.1).
- **The turn deadline disappears.** `agent-command-execution-architecture.md` §6.3 budgeted 1,200 ms
  of command work *on top of* a conversational latency floor that realtime §7 already puts at
  1–1.5 s. Push means the facts are assembled before the model is asked to speak, in-process, under
  the same <5 ms budget as the snapshot.
- **An entire class of reliability machinery becomes unnecessary**: the watchdog, the one-result
  invariant, the circuit breaker, per-effect-class concurrency, turn-scoped memoisation, cancellation
  of in-flight calls on barge-in, and the ten-code failure taxonomy. None of it was over-engineering
  for what it did; all of it existed because an unanswered function call stalls a voice conversation.
  With no function calls, nothing can stall.
- **No consent surface, and no protocol coordination event** (§2.3).
- **The retention ladder loses its one order-dependent rule** (§2.5).

### 3.2 What it costs — and this is the real one

**The agent loses the ability to ask for anything it was not given.** That is not a small loss and
it should not be presented as one. Concretely:

| The player asks | Before | After |
|---|---|---|
| "What does Blade Mail cost?" | `get_item_info` | The model answers from training data, or says it is not sure |
| "How's SF doing?" | `get_enemy_detail(sf)` | Whatever the snapshot's `enemies` and `seen` sections carry, which is less |
| "Am I behind?" | `get_build_benchmark` | The preamble's benchmark for this hero, fetched at draft — coarser and not clock-current |
| "Where is everyone?" | `get_minimap_summary` — a *fresh* CV pass | The last observed positions, with ages |

Three mitigations, in order of how much they actually help:

1. **A player-initiated turn gets a broad brief** (§6.1, `player_question`). No cause to focus on
   means the widest brief the budget allows, which recovers most of rows 2 and 4.
2. **Reference data moves entirely into the preamble** (§5.3). It was always patch-keyed and
   disk-cached; fetching it at draft for the ten heroes in this game covers row 3 and much of row 1.
3. **The model must say when it does not know.** This is a persona rule (§7.4), and it is the one
   that cannot be skipped: a coach who confidently invents an item cost is worse than one who says
   "I'd check that". realtime §11.6 documents that a model with a gap fills it.

There is a fourth, non-mitigation, and naming it is the honest thing to do: **row 4 is not
recoverable.** Nothing else in the system requests a fresh CV pass on demand. §5.3 keeps
`CapturePort` reachable from the coaching module for exactly this reason, and §15 lists
trigger-driven capture as undecided rather than pretending the gap is closed.

### 3.3 The risk that P2 introduces

dota2 §6.4's last line is the warning to keep: *"Unprompted speech is the feature most likely to
make Riki annoying enough to uninstall."* That was written when unprompted speech was one of two
paths. Making it the primary path raises the stakes on every gate in §6.3, and it is why the quiet
trigger (§6.4) is specified with a conservative default and why `quiet-mode` (§7.1) stops being a
nicety.

---

## 4. The coaching module

### 4.1 Where it lives, and why it is two places

Coaching splits cleanly along a line the repo has already drawn:

| Half | Question | Package | Specified in |
|---|---|---|---|
| **Trigger** | Is now a moment worth speaking about, and about what? | `packages/events` | dota2 §6.4, and `coaching-trigger-architecture.md` — **in flight** |
| **Content** | Given that moment, what should the model be shown? | `packages/context/src/coaching/` | This document, §4–§5 |

Putting the content half in `packages/context` rather than in a new `packages/coach` is the
load-bearing choice, and the argument is context-and-memory §2.2's:

> Nobody can enforce a ceiling on a resource they can only see a third of.

The coaching brief is a third claimant on the same conversation window as the snapshot and the
conversation. A separate package would recreate exactly the problem `PrefixBudget` and
`RetentionPolicy` exist to solve, and it would need its own copy of `AgeFormatter` — which
context-and-memory §5.1 warns is how two renderers end up disagreeing about whether to say
"probably".

Putting the trigger half in `packages/events` keeps the existing dependency DAG intact:
`world-model → context → events`. Events already imports `CoachingMemoryReader` and `AdviceTopic`
from context (context-and-memory §9.3, and the one allowed edge between them). §4.4 adds one more
type to that import and nothing else changes.

**REPO_SKELETON §2.2's ownership map needs one row changed and one added**, and that is a doc
change in the deletion ticket:

| If your task is about… | Work in |
|---|---|
| ~~Agent tools (`get_enemy_detail`, …)~~ → **The coaching brief the LLM is given** | `packages/context` |
| **What Riki coaches on, and when** | `packages/events` |

### 4.2 Directory layout

```
packages/context/src/
├── common/               + timers.ts, and ReferenceDataPort/CapturePort move into ports.ts (§2.2)
├── render/               unchanged — the primitives the brief composes
├── preamble/             unchanged, except it now owns all reference-data enrichment (§5.3)
├── snapshot/             unchanged
├── memory/               `command` ledger arm → `brief`; retention ladder loses two rungs (§2.5)
├── coaching/                                                            ← new
│   ├── types.ts          BriefRequest, CoachingBrief, BriefSectionId
│   ├── contracts.ts      BriefPlanner, BriefRenderer
│   ├── plan.ts           BRIEF_PLAN — event kind → the sections it needs, in priority order
│   ├── render.ts         sections → budgeted text, composed from render/
│   └── sections/         one file per brief section (§5.4)
└── testing/index.ts      now the home of FakeWorldModel, observed, FakeReferenceData, ManualTimers

packages/events/src/        ← owned by coaching-trigger-architecture.md; shape as it stands in flight
├── types.ts                CoachEventKind, Detection, CoachEvent, SuppressionReason, TriggerDecision
├── contracts.ts            EventDetector, SalienceScorer, TriggerPolicy, EventTape
├── config.ts               thresholds and cooldowns, injected from @riki/config
├── detect/                 combat · economy · map · timings — one detector per CoachEventKind
├── salience.ts             kind weight × instance magnitude × urgency (§6.2)
└── intensity.ts            the mid-fight suppression signal
```

The one thing that directory needs from this document is `BriefSectionId`, and §4.4 concludes it
should **not** import it: the plan table lives on the context side.

### 4.3 The vocabulary

Declarations only; the shapes are the contract.

**`TurnCause` is not changed.** An earlier draft of this section proposed a `CoachingCause` union to
replace it. The in-flight `packages/events` reuses the existing `TurnCause` trigger arm verbatim —
`{ by: 'trigger', event: EventId, salience: number }` — so that the composition-root adapter is a
field copy rather than a translation, and that is the better call. What the brief needs beyond it is
one field, and §6.6 records it as the seam gap to close rather than a type to redesign here.

```ts
/** What the planner is given. `topic` is the field §6.6 is about. */
export interface BriefRequest {
  readonly turnId: TurnId;
  readonly cause: TurnCause;
  /** From the CoachEvent, for a trigger turn. Absent for a player or system turn. */
  readonly topic?: AdviceTopic;
  readonly now: MonoMs;
  readonly budget: Budget;
  readonly privacy: PrivacyPolicy;
}

/** What the model is given for a coaching turn, alongside the snapshot. */
export interface CoachingBrief extends RenderedText {
  readonly turnId: TurnId;
  readonly sections: readonly Section[];
  /** Dropped by the budget or by the confidence gate. Telemetry, and asserted by golden tests. */
  readonly omitted: readonly BriefSectionId[];
}

export interface BriefPlanner {
  /** Pure. Which sections this request needs, in priority order. A lookup, not a scoring function. */
  plan(req: BriefRequest): readonly BriefSectionId[];
}

export interface BriefRenderer {
  /** Pure, synchronous, and inside the same <5 ms budget as the snapshot (§5.5). */
  render(world: WorldSnapshot, req: BriefRequest): CoachingBrief;
}
```

Two properties are inherited from the design being deleted and are worth carrying over by name,
because they were the two best things about it:

- **Total functions.** Nothing in the brief path throws or rejects. A section that cannot be
  rendered is omitted and recorded; a brief that renders nothing is a turn that does not happen
  (§6.5), not an exception.
- **A stale fact renders with its age and confidence or it does not render.** The brief composes
  `render/`'s `AgeFormatter`, so a bare value is not reachable. dota2 §4 rule 3, unchanged.

### 4.4 The brief plan — a lookup table, and where it lives

An earlier draft proposed an "advice catalogue" in `packages/events` carrying, per topic, a
detector, a salience spec, a cooldown, an outcome rule *and* the brief sections it wants. The first
four of those are the in-flight `packages/events`' design — `EventDetector`, `SalienceScorer`, the
cooldown gates — and it separates them deliberately, on the argument that folding cooldown into a
score makes the threshold untunable. That is right, and it leaves this document with the fifth
field alone:

```ts
/** The seam between the two halves. Data, owned by packages/context. */
export type BriefSectionId =
  | 'threat' | 'economy' | 'windows' | 'cooldowns' | 'positions' | 'pace' | 'history';

/** One entry per CoachEventKind, plus the two non-trigger causes. Exhaustive by type. */
export const BRIEF_PLAN: Readonly<Record<BriefPlanKey, readonly BriefSectionId[]>>;
```

**The table lives in `packages/context`, not in `packages/events`.** That is the opposite of what
the earlier draft said, and the reason for the change is the same one §4.1 uses to keep the brief
out of a separate package: section priority interacts with the token budget, and `packages/events`
must not acquire a reason to know about tokens. Events names an event kind; context decides what
that kind is worth rendering and in what order. The edge stays one-directional and no new type
crosses it — context does not even need to import `CoachEventKind` if the table is keyed by
`EventId`, which is already in `TurnCause`.

This is not a new pattern in the repo. context-and-memory §5.2's cause-driven promotion is already
*"a lookup table from `EventId` to `SectionId`, so the ordering stays a golden-testable fact rather
than a scoring function"* — the brief plan is that table, for a second renderer, in the same
package.

**The starting set is the in-flight `CoachEventKind` union, which has eight members**, not dota2
§6.4's nine: `enemy_missing`, `ult_ready`, `can_afford_key_item`, `low_hp_no_escape`, `rune_soon`,
`enemy_core_dead_window`, `stack_now`, `buyback_unaffordable`. `tower_diveable` is deliberately
absent — it needs the enemy's health, which the world model does not carry and which under the
dota2 §8.2 fairness rule could only come from the player's own screen. Shipping a detector that can
never fire would read as coverage. That reasoning is theirs and this document adopts it.

Adding a topic therefore costs one detector file in `packages/events` and one row in `BRIEF_PLAN`
here. Two files, two packages, no other module changes behaviour — which preserves the tool
registry's one genuinely good property (§14).

---

## 5. How state capture and context/memory feed coaching

### 5.1 The read path is unchanged, and that is the point

```
GSI ─┐
log ─┼─► packages/world-model ──► WorldSnapshot ─┬─► snapshot/  (Tier 2, general, per turn)
CV ──┘   fusion · precedence · confidence · age  ├─► coaching/  (the brief, focused, per turn)
                                                 └─► events/    (detection, over deltas)
```

Every arrow out of the world model is a `WorldSnapshot` with provenance, confidence and staleness
already attached. **No coaching code reads a source.** state-capture §7.1's rule survives the
deletion intact and for the same reason it was written: a second path from a CV detection to the
LLM would be one with no precedence, no confidence gate and no age — and the brief is exactly the
kind of focused, urgent thing that would be tempted to take one.

`packages/events` reads deltas rather than snapshots, through the same reader's `onVersion` and
`history` methods. Detection over a delta rather than a poll is what makes `enemy_missing` a
*transition* rather than a state, which is what makes it worth speaking about once.

### 5.2 Memory feeds coaching in three places, and coaching feeds it back in two

Everything here already exists (P6). The wiring is new; the components are not.

| Direction | What | Mechanism |
|---|---|---|
| Memory → trigger | Has this advice already been given, and did the player act on it? | `CoachingMemoryReader.recent(topic, within)` — the novelty gate (§6.3) |
| Memory → trigger | Has Riki been silent for a long time? | `CoachingMemoryReader.silentFor(now)` — the quiet trigger (§6.4) |
| Memory → brief | What did this player do the last time we said this? | Durable `PlayerMemory.adviceTendency` (ADR-0013), read at **preamble** assembly, not per turn |
| Coaching → memory | What was said, on what topic, at what time | `ledger.append({kind:'agent_said', topics})` — the topic comes from the trigger, never from the text |
| Coaching → memory | Did it land? | `CoachingMemory.observeOutcome` — the item appears in the inventory, or the gold went elsewhere. Observed in the world model, not inferred from the conversation |

The last row is the one that makes proactive coaching improve rather than merely repeat.
context-and-memory §6.3 already argues it: *"The player saying 'yeah okay' is worth nothing; the
item is worth everything."* Under P2 that argument gets stronger, because a proactive coach that
cannot tell whether it is being useful is a proactive coach that will keep saying the same thing.

**One ledger change.** The `command` arm of `LedgerEntry` is replaced by:

```ts
| { readonly kind: 'brief'; readonly turnId: TurnId; readonly rendered: RenderedText;
    readonly sections: readonly BriefSectionId[]; readonly at: MonoMs }
```

Same shape as `snapshot`, and for the same reason: it is context we injected, it is superseded by
the next one, and retention has to be able to find and drop it (§2.5).

### 5.3 Reference data moves to the preamble, entirely

Three of the eight deleted commands were reference lookups — item info, matchup advice, build
benchmarks. They were the `reference` effect class, patch-keyed and disk-cached, and
[ADR-0019](../adr/0019-get-build-benchmark-is-reference-class.md) exists precisely because one of
them was mis-classified as fast enough to answer inline.

After the deletion there is exactly one consumer left, and it is the one that was always the better
fit: **preamble enrichment at draft** (context-and-memory §4.3). Ten heroes, priority-ordered,
best-effort, with a 3-second deadline that runs concurrently with the draft. `ReferenceDataPort`
survives the move to `common/ports.ts` unchanged, and §8.5's requirement that the cache be warmable
before a session becomes more important rather than less — it is now the only chance to fetch this
data at all.

**`FreshCaptureRequest` does not survive.** It was invented by the command design (`tools/fresh.ts`)
so that `get_minimap_summary` could ask for a fresh pass and wait on a version bump. It is
command-execution machinery — a deadline, a cancel signal and a promise that has to resolve exactly
once — and it goes with everything else in §2.1.

**`CapturePort` survives because it is not ours to delete.** It is the sidecar control channel,
specified by `state-capture-architecture.md` §4.3, implemented at the other end by
`crates/riki-vision`, and declared in `tools/ports.ts` only as a structural mirror pending
`packages/protocol` — the file's own header says exactly that. After the deletion it has no caller
inside `packages/context`, which is a fact worth stating rather than dressing up: coaching does not
request captures, and §15 leaves trigger-driven capture undecided rather than building it
speculatively. If the reviewer would rather the mirrored declaration go too, deleting it is a
one-line change and state-capture re-declares it when `packages/protocol` lands; this document
keeps it only because deleting another design's type as a side effect of this one would be the
wrong kind of tidy.

### 5.4 The brief sections

The unit of composition, one file each, exactly as the snapshot's sections are. Each declares a
priority, whether it is droppable, and renders from a `WorldSnapshot` through `render/`. The
starting set follows from what the trigger side's eight event kinds ask for:

| Section | Carries | Typical cause |
|---|---|---|
| `threat` | Which enemies can reach the player, with ages and confidence | `low_hp_no_escape` |
| `economy` | Gold, net worth, the next item and its remaining cost | `can_afford_key_item`, `buyback_unaffordable` |
| `windows` | Rune, Roshan, stack and day/night timings relative to now | `rune_soon`, `stack_now` |
| `cooldowns` | The player's abilities and the enemy ultimates we have seen | `ult_ready`, `enemy_core_dead_window` |
| `positions` | Last-known enemy positions, with age — the `seen`/`unseen` pair | `enemy_missing` |
| `pace` | Actual versus benchmark farm and level at this clock | phase triggers |
| `history` | What Riki already said on this topic, and whether it landed | any repeat |

`history` is the section with no equivalent in the deleted design, and it is the one that makes
proactive coaching not feel like an alarm clock. If a topic is being raised a second time, the
model should be told so and told how the first attempt went, so it can say *"still worth getting
that BKB"* rather than repeating itself verbatim.

### 5.5 The brief is inside the snapshot's budget, not beside it

Brief assembly is pure, synchronous, and shares the snapshot's <5 ms per-turn budget (dota2 §6, the
`agent-context` skill). The same three rules keep it structural: no arithmetic inside a section
(that is a `packages/world-model` derived rule), token counts memoised per section body, and the
event tape read rather than scanned.

The stronger version of the same claim: **the brief must not be able to make a turn slow.** The
whole reason the deleted pipeline needed a watchdog, a breaker and a queue was that a command could
reach a network. A brief that could reach a network would earn all three back, which is why §5.3
puts reference data in the preamble and why `CapturePort` has no consumer.

---

## 6. Proactive triggering

High level, per the ticket. §6.2 gives the salience *shape* and refuses to give its coefficients;
§15 records why.

### 6.1 Five kinds of trigger

dota2 §6.4 describes one kind — a world-model delta crossing a threshold. Making coaching the
primary path means three more, and they are what separates a coach from an alert system.

| Kind | Fires on | Example | Notes |
|---|---|---|---|
| **Event** | A world-model delta | `enemy_missing`, `low_hp_no_escape` | dota2 §6.4's list. Reactive, highest salience, shortest useful life |
| **Window** | A predicted moment approaching | `rune_soon`, Roshan window opening, stack timing | *Predictive* — fires before the moment, which is the only time the advice is actionable. Needs a lead time per topic *(tunable)* |
| **Phase** | A game-phase transition | Laning → mid-game, first item spike, buyback becoming affordable | Low salience, high value, and the least annoying kind — it is advice about the next few minutes rather than the next few seconds |
| **Quiet** | Nothing said for a long time, and the moment is safe | "You're farming well — think about where you want to be at 20 minutes" | §6.4. The one that makes Riki feel present. Also the one most likely to be irritating if the gates are loose |
| **Player** | Push-to-talk, or wake word | Any question | Not proactive, not deleted, and still the highest-priority turn — it pre-empts everything below it |

The taxonomy matters because the gates apply differently: an event trigger that misses its moment
is worthless and should be dropped rather than queued, while a phase trigger can wait for a quiet
moment without losing value. That is a per-kind property, not a global policy.

**Two of these five are proposals against a closed union, not descriptions of it.** The in-flight
`CoachEventKind` has eight members and all of them are Event or Window kind; there is no Phase
trigger and no Quiet trigger. Adding either means adding an arm, a detector and a `BRIEF_PLAN` row,
and the Quiet trigger in particular needs `CoachingMemoryReader.silentFor()` — which
`packages/events` already reads for the novelty gate, so no new edge. Neither is required for the
first coaching build, and §15 keeps the Quiet trigger explicitly undecided. They are listed here
because a taxonomy that stopped at "things that go wrong" would design an alarm system, and §6.4
is the argument for why that is not the same product.

### 6.2 Salience, and the one input worth adding

Owned by `coaching-trigger-architecture.md`, whose `SalienceScorer` is **kind weight × instance
magnitude × urgency** — with `magnitude` and `actWithinSeconds` produced by the detector, so a hero
missing for 40 s scores above one missing for 21 s, and advice that would arrive after its window
closed scores toward zero. That decomposition is better than the decaying-weight sketch this
section previously carried, and it is adopted rather than restated.

Two things this document adds to it, both from the memory layer rather than from the game:

1. **Confidence must be carried.** A CV-derived detection at 0.55 confidence is worth less than the
   same detection from GSI. state-capture §5.5 puts confidence on every fact; if salience drops it,
   the confidence gate becomes decoration at exactly the point it matters most.
2. **Whether this player acts on this kind of advice** — durable memory's `adviceTendency`
   (ADR-0013). A player who has ignored rune reminders across four matches should hear fewer of
   them. This is the only place proactive coaching adapts to a *person* rather than to a game, and
   it is most of the argument for durable memory being worth a persistence surface at all
   (context-and-memory §6.4). It is a **preamble-time** read, not a per-turn one, so it costs
   nothing on the hot path.

Coefficients are in neither document, deliberately: they are unmeasurable without a replayed corpus
and a human judging the output, and a number written down would be treated as decided. §16 step 8.

### 6.3 The gates

Owned by `coaching-trigger-architecture.md`, and its `SuppressionReason` union is more complete
than the five-gate table this section previously carried — thirteen exhaustive, individually
counted reasons including three this document had missed and should not have:

- **`latched`** — the condition has been continuously true since Riki last mentioned it. This is
  the difference between "your ult is up" said once and said every three seconds for a minute, and
  no cooldown expresses it, because a cooldown cannot tell a recurrence from a persistence.
- **`agent_speaking`** — a second trigger does not queue behind the first. Same rule as §6.5, and
  it belongs on the gate list rather than only in prose.
- **`not_in_match`** — no live match, or a mode where the advice would simply be wrong: Turbo,
  Ability Draft, custom games. Riki confidently coaching Ability Draft on standard timings is a
  failure mode neither document had until that gate existed.

The one property this document asks for and will keep asking for: **every refusal is recorded**, so
that "Riki said nothing" is never indistinguishable from "Riki noticed nothing". The ledger's
`turn_closed: 'silent'` entry (context-and-memory §3.3) plus the per-reason counters are, together,
the primary tuning signal under P2 — the ratio of triggers detected to turns spoken, broken down by
which gate refused, is the number that says whether the thresholds are right. §12 row 2 cannot be
answered without it.

### 6.4 The quiet trigger, and its conservative default

The quiet trigger is what makes a proactive coach feel like a presence rather than a hazard
detector. It fires when *nothing* is wrong: no event, no window, no phase change, but Riki has been
silent for a while and the moment is safe.

It is also the trigger with the worst failure mode, because by construction it has no urgency to
justify itself. Three rules keep it honest:

- **It has the lowest kind weight of anything that can fire**, so any real trigger pre-empts it.
- **It requires a safe moment**, which is the intensity gate inverted: not merely "not in a fight"
  but "farming, alive, no enemies nearby".
- **Its default silence threshold is long** *(tunable: 4 minutes)*, and dota2 §6.4's instruction —
  *"the threshold should start conservative and be user-tunable"* — applies to it more than to
  anything else.

### 6.5 One trigger, one utterance

Two rules that close the loop, and both prevent a class of bug that the deleted design's turn scope
used to handle:

- **A brief that renders nothing is a turn that does not happen.** If the sections a cause asked
  for are all empty or all below the confidence floor, there is nothing to say, and the correct
  behaviour is to record a silent turn rather than to open a session turn and let the model
  improvise. This is the coaching equivalent of the total-function rule: the failure is a value.
- **A trigger that fires while a turn is open is dropped, not queued** — except a player-initiated
  one, which pre-empts. Queueing a coaching trigger means speaking about a moment that has passed,
  and dota2 §6.4's real complaint about unprompted speech is not that there is too much of it but
  that it arrives late. The in-flight design has this as the `agent_speaking` suppression reason,
  which is the same rule with a counter attached.

### 6.6 Where the two halves do not yet meet

Four differences between this document and the in-flight `packages/events`, listed so the seam is
closed on purpose rather than discovered. Three are already resolved above in favour of the
in-flight design; the fourth is a real gap and belongs to whoever wires the composition root.

| # | Difference | Resolution |
|---|---|---|
| 1 | This document proposed a `CoachingCause` union; `packages/events` reuses `TurnCause`'s existing trigger arm | **Theirs.** §4.3 — no type changes, and the adapter stays a field copy |
| 2 | This document put the brief-section table in the catalogue in `packages/events` | **Neither, as first written.** §4.4 moves it to `packages/context`, so the salience path never acquires a reason to know about tokens |
| 3 | This document listed `tower_diveable` among the starting topics | **Theirs.** It cannot be detected without the enemy's health, which the fairness rule puts out of reach. §4.4 |
| 4 | **`TurnCause` carries `EventId` and salience but not `AdviceTopic`. The brief planner and the novelty gate both key on topic** | **Open.** See below |

Row 4 is the gap. `CoachEvent` carries `topic: AdviceTopic`; `CoachingTrigger.cause` does not,
because it mirrors a `TurnCause` that predates coaching. The composition root holds the whole
`CoachEvent`, so the fix is a field on `BriefRequest` rather than a change to `TurnCause` (§4.3) —
but it has to be *decided*, because the alternative is `packages/context` deriving a topic from an
`EventId` through a second lookup table that can silently disagree with the one the novelty gate
uses. Two tables that must agree about what "the same advice" means is precisely what
`AdviceTopic` being a closed union exists to prevent (ADR-0013).

The cheapest correct answer, proposed here and not settled: **the composition root passes
`CoachEvent.topic` into `openTurn`**, `BriefRequest.topic` carries it, and `agent_said.topics` is
populated from the same field. One value, one origin, three consumers.

---

## 7. Voice intents and the overlay after the deletion

### 7.1 Local commands survive, and they matter more

`packages/realtime/src/commands.ts` parses four control phrases locally from a transcript, so they
work when the model is slow, unavailable or misbehaving. voice-input §6.2 was honest about how
little they earned under push-to-talk: *"the player must hold the trigger to be heard at all, and
holding the trigger during Speaking* is *barge-in"*.

**P2 changes that arithmetic.** Under proactive coaching, Riki speaks when the player is not
holding anything, so:

| Phrase | `LocalCommand` | After |
|---|---|---|
| "stop" / "shut up" | `stop` | Unchanged, but now reachable in a situation where the player did not initiate anything |
| "mute" / "mute for ten minutes" | `mute` | Unchanged |
| **"only when I ask"** | `quiet-mode` | **The most important one in the product.** It is the off switch for the primary path — dota2 §6.4's "hard 'only when I ask' mode" — and it must work without the model |
| "never mind" | `cancel` | Unchanged |

The grammar rules from voice-input §6.3 are unchanged and are what keep this safe: whole-utterance
or final-clause matching only, normalised edit distance with a per-command floor, a negation guard,
and no natural-language classification anywhere. "Don't stop farming" must not mute Riki mid-fight.

### 7.2 Two chip states die

overlay-architecture §4.4 is explicit that `Acting` and `Confirming` exist for exactly one thing:

> **Acting** — a tool call slow enough to need its own pixels — `read_screen` (a VLM round trip),
> `get_matchup_advice` on a cold cache.
> **Confirming** — the consent gate in front of `read_screen`.

Both sources are deleted. Nothing in the coaching path is slow enough to need its own pixels —
brief assembly is in-process and under 5 ms — and nothing needs consent. A state with no producer
is a state that will keep its tests, keep its colour token and never be entered, so both go:

| Surface | Removed |
|---|---|
| `apps/desktop/src/main/session/types.ts` | `Phase` arms `acting` and `confirming`; `ActingVerb`; `ConfirmPrompt`; `TimerId` `'confirm-timeout'` |
| | `Effect` arm `keys`; `VoiceCommand` arm `consent` |
| `apps/desktop/src/shared/overlay.ts` | `ChipState` `'acting'`, `'confirming'`; `AccentToken` `'confirm'`; `Affordance` `'confirm'`; `OverlayIntent` `confirm` |
| `apps/desktop/src/shared/intents.ts` | The `confirm` case in `parseOverlayIntent` |
| `apps/desktop/src/main/session/machine.ts` + `machine.test.ts` | The transitions into and out of both, and the scoped-accelerator effects |
| Renderer | The Confirming affordance row and the Acting verb slot in `view/chip.ts`, plus the `confirm` accent in `tokens/` |

`ui-design.md` §5.1 describes the verb slot and the confirm affordance as part of the chip's visual
language, so that document needs the same edit. This is an `overlay-ui` change and its skill applies.

**What replaces them: nothing.** A coaching turn is `Speaking` with `unprompted: true`, which
overlay §9.3 already specifies end to end — no Armed, no earcon, an 80 ms fade-in, and barge-in
from it costs exactly one key press. That path exists, is tested, and is now the most common thing
the chip does.

### 7.3 The routing table, before and after

| Input | Before | After |
|---|---|---|
| Push-to-talk, player question | Model → `function_call` → tool pipeline → result → speech | Model answers from snapshot + broad brief + preamble. **No dispatch** |
| Model emits a function call | `ToolCallPort.dispatch` | Counted in telemetry, ignored, never answered (§2.4). Should be zero |
| `read_screen` proposed | Consent → `Confirming` → `Y`/`N`/`Esc` → capture → VLM → `Acting` | **Does not exist** |
| Slow reference lookup | `Acting`, with a verb | Fetched at draft into the preamble; nothing mid-turn |
| Coaching moment detected | *(nothing — no producer existed)* | `packages/events` → gates → `openTurn(cause)` → brief → `Speaking(unprompted)` |
| "only when I ask" | Local parser → `RIKI_UNPROMPTED=off` | Same path, far more load-bearing (§7.1) |
| Barge-in during Riki speaking | Truncate + `cancelTurn` unwinds in-flight commands | Truncate. **There is nothing in flight to unwind** |

The last row is the quiet win. Barge-in cancellation was a correctness requirement in the deleted
design — a command result submitted after truncation answers a question the conversation no longer
contains — and it is the kind of bug that is nearly impossible to reproduce. It cannot happen now.

### 7.4 Voice and style

Per P3: **clear, concise, encouraging.** One or two sentences, the actionable thing first, no
preamble, no repetition of what the player can see. Encouraging means the framing is what to do next
rather than what was done wrong — "get the BKB before the next fight", not "you should have bought
BKB".

One rule is not stylistic and cannot be skipped: **say when you do not know.** §3.2 removes the
agent's ability to look things up, and realtime §11.6 documents that a model with a gap fills it.
"I'd double-check that" is a coach; a confidently invented item cost is a liability.

Where this text lives is REPO_SKELETON §11.5 / open question 5, still open, and now more urgent
(§2.6): with no tool descriptions, the preamble persona is the *only* thing shaping how Riki
sounds. The proposal on the table — versioned files in `packages/context/prompts/` with golden
tests — is unchanged and this document does not settle it.

---

## 8. Budgets, revised

### 8.1 The cached prefix

context-and-memory §4.2's table, with the manifest row removed:

| Part | Before | After |
|---|---|---|
| Persona and speaking rules | 1,200 | 1,200 |
| Preamble: player, draft, matchups, patch, benchmarks, history | 1,500 | **1,800** — reference data that commands used to fetch now lives here (§5.3) |
| Tool manifest | 2,000 | **0** |
| Committed | 4,700 | **3,000** |
| Headroom, against the 16,384 cap | 11,684 | **13,384** |

`PrefixBudget` stays and keeps its Tier 1 assertion; it simply has one fewer part to sum. The
headroom was comfortable before and is more so now, which is worth saying plainly rather than
implying a tightness that does not exist. What the budget object is actually for is unchanged: the
preamble is the part that grows without anyone deciding to grow it, and 300 extra tokens of
reference data is exactly the kind of "one more line per hero" change it exists to catch.

### 8.2 The conversation window

context-and-memory §7.1's per-minute table, re-derived. Every number is an estimate and §12 carries
them forward as unverified:

| Contributor | Before | After |
|---|---|---|
| Assistant audio | ~200 | ~200 |
| User audio | ~50 | **~25** — the player asks less when they are being told |
| Snapshot | ~300 | ~300 |
| Command results | ~200 | **0** |
| **Coaching brief** | — | **~150** *(tunable ceiling: 200/turn, K5's one turn per minute)* |
| Total | ~750 | **~675** |

Against ~28,672 usable, that moves first compaction from roughly 38 minutes to roughly **42
minutes** — still inside a long match, so context-and-memory §7's conclusion is unchanged:
compaction is a normal event, not a failure path, and the machinery in §7.3 still needs to exist.

The more useful change is qualitative. The brief **replaces itself** the way the snapshot does — one
per turn, superseded by the next — whereas command results **accumulated**. Retention now has two
self-superseding claimants and one accumulating one (the conversation), instead of two accumulating
claimants with an ordering dependency between them (§2.5). That is a simpler thing to keep under a
ceiling, and it is why the drop order collapses from five rungs to four.

---

## 9. Integration

### 9.1 Every counterpart, in one table

If a row is not here, coaching does not talk to it.

| Counterpart | Direction | Carried by | What flows |
|---|---|---|---|
| `packages/world-model` | in | `WorldModelReader` | `snapshot()`, `onVersion()`, `history()` — for both the brief and detection |
| `packages/context` → `packages/events` | out | `CoachingMemoryReader` (plain type import) | Advice already given, whether it landed, how long since Riki spoke |
| `packages/events` → `packages/context` | in | `EventTapeReader` (port, wired at the root) | The `recent:` tape |
| `packages/events` → `packages/context` | in | `TurnCause` + `AdviceTopic` on `openTurn` | Why this turn exists, and what it is about (§6.6 row 4) |
| `packages/realtime` | out | composition root adapter | Preamble + snapshot + brief; `response.create` |
| `packages/realtime` | in | composition root adapter | Transcripts → `agent_said`/`player_said`; `LocalCommand`; session lost → rehydrate |
| `packages/audio` | in | via the session machine | Speech activity for the player-speaking gate (§6.3) |
| `apps/desktop` overlay | out | the session machine | `Speaking(unprompted)`. **No Acting, no Confirming** |
| External APIs | out | `ReferenceDataPort` | Draft enrichment only (§5.3) |
| `packages/config` | in | injected | `RIKI_UNPROMPTED`, `RIKI_MEMORY`, thresholds, tunables. Never `process.env` |
| `packages/telemetry` | out | `ContextTelemetry` | Brief render latency and tokens; **triggers fired vs. turns spoken**, per gate |
| `crates/riki-vision` | — | — | **No edge.** `CapturePort` survives with no consumer (§5.3) |

### 9.2 One coaching turn, end to end

```
world model version bump
      │
      ▼
packages/events: detect ──► salience ──► gates ──┬─ refused ──► ledger: turn_closed 'silent'
      │                                          │              (the tuning signal, §6.3)
      │ admitted                                 │
      ▼
ContextAssembler.openTurn({ by:'coaching', topic, event, salience })
      │
      ├─► SnapshotRenderer.render()   ─┐
      ├─► BriefPlanner.plan(cause)     ├─ <5 ms total, pure, in-process
      └─► BriefRenderer.render()      ─┘
      │
      ├─► ledger.append({kind:'snapshot'}) and ({kind:'brief'})
      ▼
packages/realtime: inject, response.create ──► overlay: Speaking(unprompted:true)
      │
      ├─ barge-in ──► truncate. Nothing in flight (§7.3)
      ▼
transcript ──► ledger.append({kind:'agent_said', topics:[topic]})
      │
      ▼
closeTurn('spoke') ──► Compactor.consider() ──► WindowPlan | null
      │
      └─► later: CoachingMemory.observeOutcome() — did the item appear? (§5.2)
```

The topic on `agent_said` comes from the trigger, before a word is spoken — never from the text.
Nothing in this path classifies natural language, which is what keeps the novelty gate
deterministic and ADR-0013's free-text prohibition structural rather than remembered.

### 9.3 The composition root

`apps/desktop/src/main/agent/` was proposed by both existing design documents and **never created**,
so there is nothing to delete. The coaching subsystem takes the slot, and REPO_SKELETON §2.2's
ownership gap — flagged twice and still open — should be closed by the same doc edit as §4.1's.

---

## 10. Failure modes

The dota2 §9 table. Every row degrades loudly to the developer, quietly to the player, and never
silently into wrongness.

| Failure | Detected by | Response |
|---|---|---|
| A brief section has no data | `BriefRenderer` | Section omitted and recorded. If *every* section is empty, no turn happens (§6.5) |
| All facts a topic needs are below the confidence floor | The confidence gate in `render/` | Dropped, not hedged. The turn does not happen |
| Trigger fires while a turn is open | `TriggerPolicy` | Dropped, not queued — except a player turn, which pre-empts (§6.5) |
| Triggers fire far more often than turns are spoken | `turn_closed: 'silent'` ratio in telemetry | Working as designed until the ratio inverts; it is the primary tuning signal, not an error |
| Riki says nothing for a long time | `CoachingMemoryReader.silentFor` | The quiet trigger (§6.4). Also visible in telemetry, which is the point of recording silence |
| Riki repeats advice | Novelty gate | Should be impossible for a topic in `CoachingMemory`. A non-zero count is a bug — the same class as `api_truncation` |
| Player mutes or says "only when I ask" | Local parser (§7.1) | Every coaching trigger refused at the first gate. Must work with the model down |
| Reference data missing at draft | Enrichment deadline (context-and-memory §4.3) | Preamble ships without it; `degraded` records which. Riki coaches without benchmarks |
| GSI silent | Staleness on the facts | Brief renders with ages; expired fields absent rather than guessed |
| Sidecar dead | `SourceSupervisor` | Position-dependent topics stop detecting. Riki coaches on what GSI still gives, and says less rather than something wrong |
| The model emits a function call | The retained wire branch (§2.4) | Counted, ignored, never answered. Should be zero |
| Session lost mid-match | `packages/realtime` | Rehydrate from the ledger. The brief is not replayed; the advice-topic list is (context-and-memory §7.5) |
| Brief renders slowly | The <5 ms budget, Tier 4 | Alerts. Anything that could make this slow is a design error, not a condition (§5.5) |

---

## 11. Module boundaries

| Boundary | Rule | Held by |
|---|---|---|
| `packages/context` → `packages/realtime`, `events`, `gsi`, `log-tail`, `electron` | Forbidden | Existing lint (context-and-memory §2.3) — unchanged |
| `packages/context` → `node:fs`, `node:path` | Forbidden | Existing lint — unchanged |
| `packages/events` → `packages/context` | **Allowed**, types only: `CoachingMemoryReader`, `AdviceTopic`, `TapeEvent` | The edge that already exists. §4.4 keeps `BriefSectionId` off it — the plan table lives on the context side |
| `packages/events` → `packages/realtime`, `apps/*`, `electron` | Forbidden | **Lint to add** with the implementation, not before |
| `packages/events` → `packages/world-model` | Allowed | Detection reads deltas through the reader |
| A brief section → another brief section | Forbidden | **Lint to add** — sections are leaves, exactly as handlers were |
| `process.env` | Only `packages/config` | Existing rule |
| `console.*` | Only `packages/telemetry` | Existing rule — hence `ContextTelemetry` as a port |

Every "lint to add" lands **with the code it constrains**, and each must be proven by writing a
violating file, running `pnpm exec eslint` on it, watching it fail, and deleting it. The `workspace`
skill's first learning is that a rule verified any other way is a comment — and its correction is
that a *cross-package* rule also needs the dependency actually installed, or the import does not
resolve and the rule reports success on a file written to violate it.

---

## 12. Claims to verify before building on them

House style: what has been read versus what has been measured. None of the following has been
measured on this project.

| Claim | How to check | Consequence if wrong |
|---|---|---|
| **⚑ A ~150-token focused brief carries as much useful signal as a tool call did** | Replay a match; render both against the same moments and judge the model's answers | ⚑ The core bet. If false, either the brief grows (and §8.2's arithmetic moves) or some pull mechanism has to come back |
| **⚑ Proactive coaching at the default thresholds is welcome rather than irritating** | A human playing a real match. Not a fixture, and not measurable any other way | ⚑ P2 itself. The mitigation is §6.4's conservative defaults and §7.1's off switch, both of which exist because this is unverified |
| The player asks fewer questions when coached proactively (§8.2's user-audio row) | Count player-initiated turns per match, before and after | The window arithmetic moves slightly; nothing structural |
| §8.2's revised per-minute total | Token-count a replayed match against real usage reporting | Inherited unverified from context-and-memory §12 row 1, which is still the cheapest thing to measure and still unmeasured |
| Kind weight × magnitude × urgency produces sensible ordering | Replay corpus, ranked against human judgement | The scoring function changes shape; `BRIEF_PLAN` does not |
| A model told `tools: []` never emits a function call | The retained telemetry counter (§2.4) | It is already the reason the counter exists |
| Durable `adviceTendency` is a useful salience input after a handful of matches | Needs enough matches to exist | Salience loses its fourth input; the other three still work |

Rows 1 and 2 are the two that decide whether this design is right, and neither can be settled by a
test. Both need a replay harness and a person, which is why §16 puts the tuning ticket last and
gives it a harness rather than a number.

---

## 13. Testing map

Tiers are REPO_SKELETON §5.3. The decomposition exists so that almost all of it is Tier 1 against
fakes, with no game, no session and no network.

| Unit | Tier | Asserts |
|---|---|---|
| **Post-deletion suite** | 1 | **The existing `packages/context` tests still pass after the salvage move (§2.2), before anything is deleted** |
| `BriefPlanner` | 1 | Each `BriefRequest` maps to its declared sections, in priority order — a table, not a scoring function |
| `BriefRenderer` | 1 | Age and confidence on every CV-derived field; below-threshold dropped; truncation priority; `omitted` complete |
| Empty brief | 1 | A cause whose sections are all empty produces no turn (§6.5) |
| Brief privacy gate | 1 | **Egress test**: with default config, chat text never appears in a brief. Inherited from the deleted design's best test |
| Detectors, salience, gates, novelty | 1 | **`coaching-trigger-architecture.md`'s map, not this one.** The rows below are what this document asks of it |
| Suppression accounting | 1 | Every refusal appends `turn_closed: 'silent'` and increments its own `SuppressionReason` counter (§6.3) — the input to §12 row 2 |
| Salience carries confidence | 1 | A 0.55-confidence detection scores below the same detection from GSI (§6.2) |
| `BRIEF_PLAN` totality | 1 | Every `EventId` the trigger side can emit has a plan row. A missing row is a coaching turn with an empty brief, which §6.5 turns into silence |
| One trigger, one utterance | 1 | Property test: a trigger arriving while a turn is open never opens a second |
| `RetentionPolicy`, revised | 1 | The four-rung ladder; **no pairing rule survives**; briefs are superseded like snapshots |
| `PrefixBudget` | 1 | persona + preamble ≤ 16,384, with no manifest part (§8.1) |
| Local commands | 1 | Unchanged from voice-input §6.3, including the adversarial transcripts |
| Session machine | 1 | **No path reaches `acting` or `confirming`** — the deletion's regression test |
| Rendered briefs | 2 | Golden, `fixtures/golden/coaching/` — the format is an interface to the LLM, so it is a diff |
| Session config | 3 | `tools: []` is sent; a stray function call is counted and not answered (§2.4) |
| Trigger behaviour | 4 | Replayed 45-minute match: turns spoken, per-gate refusals, no repeated topic, brief latency < 5 ms at p99 |
| Window arithmetic | 4 | Replayed match: §8.2's estimate tracks reported usage; one compaction; no `api_truncation` |
| Unprompted overlay path | 5 | Playwright: a coaching turn shows `Speaking(unprompted)`, barge-in costs one key press, and no confirm keys are ever grabbed |

Three deserve their emphasis. **The post-deletion suite row is first because it is the trap** — the
salvage in §2.2 is what makes it possible to run the existing tests at any point during the
deletion. **The egress test** is the one that cannot be walked back once it fails in the field, and
it survives the deletion because the brief renders the same fields a command result did. **The
session-machine row** is how a deleted state stays deleted.

---

## 14. Extensibility

What each change costs. If one of these is expensive, the boundaries are wrong.

**Add an advice topic** — one detector file in `packages/events/src/detect/`, one arm on
`CoachEventKind`, and one row in `BRIEF_PLAN` here. Two files, two packages, and no existing module
changes behaviour. This is the change that should happen most often, and it is deliberately the
cheapest — it is the one genuinely good property the tool registry had and the main thing worth
carrying over from it.

**Add a brief section** — one file in `coaching/sections/`, one entry in the priority ladder, one
golden diff. The ladder entry is the part not to skip: a section with no declared priority truncates
in whatever order the array happened to be in.

**Change how something reads** — `render/`, and a golden diff across *both* the snapshot and the
brief at once. Prompt engineering by another name, and the cheapest change in the package.

**Change what makes Riki speak** — the gates, in `packages/events/src/gates/`. Pure functions of a
snapshot, a clock and `CoachingMemoryReader`, which is what makes the thresholds testable without a
session.

**Change the retention ladder** — `RetentionPolicy` alone, and it is now simpler than it was.

**A topic that needs data the world model does not have** — a `packages/world-model` change (one
derived rule, per state-capture §9), not a change here. If it seems to need a change to *fusion*,
the model is being asked to know it is feeding an LLM, and state-capture §7.3 says that is the
signal something has leaked.

**A topic that needs something looked up mid-match** — this is the one the deletion makes expensive,
and it should be. It means a port, a deadline, a failure path and probably a watchdog, which is the
machinery §3.1 just removed. The bar is that the deterministic version has to lose an argument
first.

---

## 15. What this design does not decide

1. **The salience coefficients, and every threshold.** §6.2 gives the shape; the numbers need a
   replay corpus and a person. §16 step 6.
2. **Whether the quiet trigger ships on by default.** §6.4 proposes a 4-minute threshold and a safe-
   moment requirement. It is the trigger most likely to be loved or hated and it needs a human call.
3. **Whether a coaching trigger may request a fresh CV pass.** `CapturePort` survives with no
   consumer (§5.3). Building it would reintroduce a deadline and a failure path into a component that
   currently has neither, so it stays open rather than being built speculatively.
4. **Where the persona lives** — REPO_SKELETON §11.5 / open question 5, unchanged and now more
   urgent (§2.6, §7.4).
5. **Ownership of external API enrichment.** Inherited unsettled from state-capture §11.3; the
   deletion removes two of its three consumers, which weakens rather than strengthens the case for
   its own package. Still open.
6. **Whether post-match coaching review ships**, which is open question 13 and is newly interesting:
   the ledger now holds a complete record of every piece of advice and whether it landed.
7. **Every number marked *(tunable)***, of which the brief ceiling and the quiet threshold matter
   most.
8. **Everything in §12**, and rows 1 and 2 decide whether the rest of this document is right.

---

## 16. Build order — the follow-up tickets

Each step is a ticket. Each leaves `main` green, and no step depends on a step after it.

1. **Salvage, without deleting anything.** Move `FakeWorldModel`/`observed`/`FakeReferenceData`/
   `ManualTimers` to `src/testing/`, `ReferenceDataPort` and `CapturePort` to `common/ports.ts`,
   `Timers` to `common/timers.ts`. Pure moves, `pnpm check` green, **its own commit.** §2.2 is the
   spec and this is the step that makes every later one reversible.
2. **Delete `packages/context/src/tools/`** and the `packages/realtime` seam (§2.1, §2.4, §2.5),
   including the ledger's `command` arm, the retention ladder's two rungs, and `PrefixBudget`'s
   manifest part. Keep `tools: []` and the ignore-and-count wire branch. The existing package tests
   are the regression suite.
3. **Delete `Acting` and `Confirming`** across the machine, the shared types, the intent parser and
   the renderer (§7.2), with the `ui-design.md` edit. Separate ticket because it is a different
   package and a different skill.
4. **Docs and ADRs** (§2.6): delete the command architecture document, sweep its inbound links,
   mark ADR-0011/0018/0019 Superseded, close open questions 9 and 10, update REPO_SKELETON §2.2's
   ownership map and the `agent-context` and `overlay-ui` skills.
5. **`packages/context/src/coaching/`** — `BriefPlanner`, `BRIEF_PLAN`, `BriefRenderer`, the
   sections, and the golden corpus. Buildable **today**, against a fake world model and with no
   session: it is a pure function of a snapshot and a request. Land it with the golden corpus, not
   after it. This is the ticket that is genuinely unclaimed, and it is the one to dispatch first.
6. **`packages/events`** — **in flight already**, against `coaching-trigger-architecture.md`. Not a
   ticket to dispatch from this document. What this document owes it is row 4 of §6.6, and what it
   owes this document is nothing.
7. **The composition root** in `apps/desktop/src/main/agent/` — wire events → context → realtime and
   the `EventTapeReader` port, and close §6.6 row 4 by passing `CoachEvent.topic` through
   `openTurn`. The first point at which anything here touches a session, and the first at which the
   two halves are in the same process.
8. **Tuning**, with a replay harness and a person. §12 rows 1 and 2, and every number in §15. Last,
   because it is the only step that cannot be done against a fixture.

Steps 1–4 are the deletion and are strictly ordered. Step 5 can run in parallel with the in-flight
step 6, which is the point of §4.4 putting the seam at a lookup table rather than at a shared type:
neither package has to wait for the other to compile.

**Sequencing note for whoever picks this up.** Steps 2 and 6 touch different packages and can
proceed in parallel, but step 2 deletes `ToolCallPort` from `packages/realtime` while step 6's
package declares a dependency on `@riki/context`. Whoever lands second reconciles, per AGENTS.md.
The deletion should not wait on the trigger work: nothing in `packages/events` imports the tool
pipeline, which is the strongest evidence available that the two are genuinely separable.

# The LLM coach

**Status:** Built. `packages/coach`, `apps/desktop/src/main/agent/{driver,narrator}.ts`, and the
tray's Coach row.
**Scope:** A second coach that decides for itself whether Riki should speak and what to say, as an
alternative to the deterministic one in `packages/events`.
**Out of scope:** The deterministic coach (`coaching-trigger-architecture.md`), what the model is
shown per turn once a moment is chosen (`coaching-architecture.md`), and the Realtime session that
does the talking (`voice-input-architecture.md`).

Decision: [ADR-0031](../adr/0031-the-llm-coach-is-an-alternative-not-a-stage.md).

---

## 1. Why

`packages/events` is rules and templates all the way down: eight detectors fire on world-model
events, a salience score and thirteen gates decide *whether* to speak, and `BRIEF_PLAN` plus a
template decide *what* to say. Nothing in that path forms a judgement.

That has a hard ceiling. A detector can only notice what somebody wrote a detector for, and a
template can only say what somebody wrote a template for. "Their Spectre has no buyback for another
minute and you have Aegis — take Roshan now" is not a gap in the gate ladder, it is a kind of
sentence the deterministic coach cannot produce at all.

So there is a second coach. It reads the same world, is triggered by the same detectors, and then a
model decides the rest.

**Both are kept.** The deterministic coach is the baseline, it is the only one tunable against a
fixture corpus with no network, and it is what runs when there is no API key.

### 1.1 The trade, stated plainly

| | `packages/events` | `packages/coach` |
|---|---|---|
| Decides whether to speak | thirteen gates, in order, each counted | one model call |
| Decides what to say | `BRIEF_PLAN` picks sections; a template renders them | the model drafts the line |
| Runs on | every world-model version bump | a **fresh** detection, rate-limited. No timer |
| Tunable with no network | yes, entirely | no |
| Why it is quiet | a `SuppressionReason`, counted per gate | a sentence, in the model's words |

The last two rows are the cost and they are not small. The primary tuning instrument stops being a
counter and starts being prose, and a coach that has gone wrong cannot be debugged by reading
`config.ts`. `CoachJudgement.reasoning` is what buys some of that back: it is recorded on every
consultation, spoken or not, and it is the answer to *why is Riki quiet* — which under a proactive
product is the question that decides whether anyone leaves the feature on.

---

## 2. Vocabulary

Two types, because one party answers all three of the deterministic coach's questions.
`packages/events` keeps detection, salience and the gates apart because three parties answer them;
here there is one input type and one output type, and the reasoning is a string rather than a score.

### 2.1 What the coach is shown

`CoachStimulus` — the whole context of one judgement. There is **no conversation across
consultations**: every call is fresh, and its entire context is this object plus the instructions.
That is what stops a forty-minute match becoming a forty-minute prompt, and it is why `spoken` is a
rendered field rather than prior turns in a thread.

`CoachSignal` is one condition a detector currently reports. It carries `magnitude` and `confidence`
— facts about the detection — and deliberately **no salience**: a weighted product of those two is a
policy, and handing the model a number that already encodes "how much this matters" would be asking
it to ratify a decision this coach exists to make itself.

### 2.2 What it answers

`CoachJudgement`: `speak`, `reasoning`, `say`, `about`, `weight`. `speak: false` is the expected
answer and the instructions say so.

**`about` is a `DetectionKey` and it must be one the stimulus listed.** This is the one thing in the
design a model is not trusted with, and the reason is [ADR-0013](../adr/0013-durable-memory-is-typed-observations.md):
`AdviceTopic` is a closed union with one origin and `agent_said.topics` is built from it. A model
free to name its own subject would make the coaching record free text with a struct around it, and
the novelty gate would be reading values no detector ever produced.

### 2.3 What it emits

`CoachUtterance`. `kind`, `key` and `topic` are **the detector's**; `weight`, `say` and `reasoning`
are **the model's**. That split is the whole contract: the model decides whether and what, the
detector decides what it is filed under.

---

## 3. Configuration

Every number that changes behaviour is in `config.ts`, the same rule `packages/events/config.ts`
holds and for the same reason: tuning is a diff to one file.

There is no cost budget and the one latency number is not a request timeout. See §4.6.

---

## 4. The coach

### 4.1 Signals

`signals.ts` turns `Detection` into `CoachSignal` by losing the score and gaining one fact: whether
the condition is **new**.

`fresh` is not a latch and not a cooldown. It is a fact about the world offered to a model that is
free to decide a long-standing condition has become worth mentioning anyway — where
`packages/events`' `latched` gate makes that decision for it and cannot be talked out of it.

Two properties are load-bearing and both are easy to lose:

- **Reading does not advance freshness.** `read` and `commit` are separate, and `commit` runs only
  once the model has actually been shown the signals. So a detection that arrives while Riki is
  muted is still new when the mute lifts: a skipped trigger is *deferred*, not spent.
- **A key survives `seen` only while its condition is still detected.** Without that pruning,
  `fresh` degrades to "never consulted about since the match began", and a condition that goes away
  and comes back is never a trigger a second time — the coach would consult once per condition per
  match and then fall silent about it forever. This is the same reconciliation the deterministic
  engine does to its latches, at the same point in the tick and for the same reason.

### 4.2 The model port

`CoachModel.judge` returns `CoachJudgement | null` and **never throws**. A failed run, a timeout, a
malformed output and a 401 are all silence plus a counter. An exception on the path that decides
whether to talk to a player mid-fight is not worth having.

### 4.3 What is not a gate

The LLM decides whether to speak. Six conditions remain under which there is no point *asking*, and
none of them is a policy:

| Skip | Why it is not a policy |
|---|---|
| `quiet_mode`, `muted` | The player's own off switches. dota2 §6.4 requires them to work with the model unreachable, which they cannot do if the model is what honours them |
| `agent_speaking` | One audio channel |
| `player_speaking` | Same channel, other direction |
| `in_flight` | One consultation at a time — two overlapping judgements would each reason about a world the other is about to change |
| `no_world` | Nothing to narrate; asking would be asking about an empty string |

Every policy arm of `SuppressionReason` is deliberately absent: `latched`, `kind_cooldown`,
`global_cooldown`, `already_advised`, `ignored_twice`, `stale_window`, `below_threshold`,
`high_intensity`. Each is a judgement about whether a thing is worth saying, and each is now the
model's. They remain in `packages/events`, intact, for the coach that owns them.

**Nothing may be added to that list without an ADR.** A seventh reason is a gate wearing a
mechanical hat, and it drifts back to the ladder one skip at a time.

### 4.4 The coach's own record

A short ring of what it has already said, read back into the next stimulus. It is **not** the
conversation ledger (that is the record of what the *session* was told, ADR-0012) and it is **not**
a novelty gate — it refuses nothing. A model that can see it said something forty seconds ago is in
a better position to decide whether to say it again than a rule that only knows it did.

### 4.5 The cadence — push-only

**There is no timer in this package.** No tick, no cadence, no `Timers` port.

A version bump is not the trigger either: the world model bumps several times a second under GSI and
almost none of those bumps mean anything. The trigger is a detector reporting a condition that was
not true at the last consultation. Two things must hold, in this order because the first is a
subtraction and the second runs eight detectors:

1. `minConsultGapSeconds` has passed — a teamfight in which six conditions become true in two
   seconds is one consultation, not six.
2. At least one detection is fresh.

A game in which nothing new happens makes **no requests at all**.

There is also no priming consultation at match start. With no detection there is nothing to
attribute an answer to, so the only legal judgement would be silence, and asking for it would be a
request spent to be told so.

### 4.6 The soft deadline

Nothing cancels a model call and nothing rushes it.

`CoachStimulus.actWithinSeconds` is derived from the signals themselves — a detector says how long
its own advice stays useful — floored by `minDeadlineSeconds` so a window no round trip could meet
is not a guaranteed abort. It is **rendered into the prompt as well as checked**, and showing it is
the point: a model that knows it has five seconds can skip the library lookup and answer.

Its only enforcement is that a *late* judgement is checked against the world before it is spoken. If
the condition it named has stopped being true, the line is dropped as overtaken; otherwise it is
spoken, late. A late line about a hero who has reappeared is wrong rather than stale; a late line
about a fight still happening is merely late, and silence is worse than late. **The default
direction is to speak**, which is what separates this from a timeout.

---

## 5. The prompt

Both halves — the instructions and the stimulus rendering — are pure, and both are the interface to
the model, so a change to either is an API change.

The instructions do **not** carry Riki's persona. The persona lives in the Realtime session preamble
and shapes how the voice sounds; this agent decides whether and what, and a second drifting copy of
the voice would produce a coach that argues with itself about tone. What they do carry is the
product promise, because that is a judgement instruction: **invisible until needed**.

### 5.2 Rendering a stimulus

Sections are omitted rather than rendered empty — an absent `signals` block and an empty one say
different things.

The **key leads each signal line**, in brackets, because it is the one token the model has to copy
back verbatim. `enemy_missing:sf` and `enemy_missing:puck` are two moments, and a model shown only
`enemy_missing` twice cannot tell us which it meant.

### 5.4 The SDK

OpenAI's Agents SDK (`@openai/agents`), not a raw chat completion. What that buys concretely is a
typed output schema the model is *made* to fill, and a tool loop the SDK runs on our behalf — the
run returns only once the model has stopped calling `lookup_hero`. Both are the parts a hand-rolled
integration gets wrong first.

Three configuration decisions:

- **A `Runner`, not the module-level `run()`.** The convenience entry point resolves a provider from
  process-global state (`setDefaultOpenAIKey`), and a key in a module global is exactly what
  REPO_SKELETON.md §7.1 exists to prevent.
- **Tracing follows config and defaults to off.** The SDK's exporter posts prompts, tool arguments
  and outputs to a second endpoint. A stimulus contains a rendered snapshot of somebody's live
  match. This is a privacy default, not a performance one, and a test asserts it.
- **A failed run is `null`, never a throw.**

---

## 6. The composition root

`agent/driver.ts` holds `CoachDriver` and two adapters. It is the one place that imports
`@riki/events` and `@riki/coach` in the same scope; neither package knows the other exists.

The port is shaped like `EventEngine` rather than like something new, deliberately: the
deterministic coach is the baseline and must not move, so the LLM side was built to fit.

The one field `CoachEvent` has no equivalent for is `guidance`. A proposal from `packages/events`
carries `null` and the brief is the whole of what is injected; a proposal from `packages/coach`
carries a drafted line that is injected **alongside** the brief rather than instead of it — the
brief still renders the facts, with their ages and confidences, which is the only way a number is
allowed to reach the model.

### 6.1 The narrator

**There is one renderer of game facts in this product.** The coach reads what the Realtime model
reads, through `packages/context`'s `AgeFormatter` and `PrivacyGate`, and never sees a
`WorldSnapshot`. No second age formatter, no second privacy gate, no second format to keep in step
— and the two models cannot contradict each other about what the game looks like.

The budget is larger than the snapshot's ~400 tokens, and that is not a loophole: the snapshot lands
in the Realtime *conversation window* where it is billed as input on every later turn, and the
coach's copy is one request that ends when the judgement does. The coach can be shown considerably
more of the game than the thing that speaks, for a cost paid once rather than forever.

---

## 7. Telemetry

`CoachCounters`: consultations, per-reason skips, spoke, declined, failed, discarded.

`declined` carries the model's reasoning and `spoke` does not carry what was said. That asymmetry is
deliberate — the reasoning behind a silence is the tuning signal this coach has instead of thirteen
counters, and it is about the game; an utterance is a transcript, and a transcript in a log is a
privacy surface.

---

## 8. Cost

One flagship-model call per fresh detection, rate-limited by §4.5. No budget machinery: the knobs
are `model` and `maxTurns`, and quality of judgement is what is being optimised first.

---

## 9. The mode switch

**A UI control, not an environment variable.** The tray's Coach row toggles it, live, and the choice
persists to `settings.json`.

There is deliberately **no `RIKI_COACH`**. Which coach runs is a product choice a player makes, and
a variable left in a shell profile would silently undo that choice on every restart — a UI control
that a stale variable can override is not a control. `RIKI_COACH_MODEL` survives because a model id
is not a mode: it configures the LLM coach, it does not select it.

Asking for `llm` with no API key resolves to `static` and reports `coachUnavailable`. The tray
reflects what actually happened rather than what was asked for, because a checkbox that ticked
anyway would be the product lying about its own state.

---

## 10. Testing

`FakeCoachModel` is the fifth shared fake, and it is what makes everything except `openai-model.ts`
a Tier 1 test — a real world model, the real eight detectors, the real signal reader and record, and
a scripted model, with no key and no network.

`openai-model.ts` itself is not unit tested and that is honest rather than lazy: every behaviour
worth asserting has been pushed out of it, and what remains is construction and one `await`, which a
test could only cover by mocking the SDK — a test that would pass against a wrong API as happily as
against a right one.

---

## 11. Boundaries

`packages/coach` may not import `@riki/realtime`, a source, or the app. The judge decides *whether*
to speak; the thing that speaks is `packages/realtime`, and a direct line would make the composition
root optional. The API key arrives as a structural `RevealableKey`, which is why that edge is not
needed for the one thing that might seem to justify it.

`@openai/*` may be imported by this package and nothing else, enforced in `boundaries/external`.

---

## 14. Open

1. **Every number in `config.ts` is unmeasured.** `minConsultGapSeconds`, `minDeadlineSeconds`,
   `maxSignals`, `maxSayChars`, `maxTurns` are starting points.
2. **No golden corpus for the prompt.** `renderStimulus` is pure and deserves `fixtures/golden/`
   the way the snapshot renderer has it; there is none yet, so a format change shows up as a code
   diff rather than as a rendered one.
3. **The event tape is empty under the LLM coach.** The tape is `packages/events`' record of its own
   detections, and in `llm` mode nothing fills it — so the narration's `recent:` line renders empty
   and the model is told nothing about what has been happening. A real gap, not a shrug.
4. **No comparison harness.** The two coaches cannot yet be run over one fixture match and diffed,
   which is the thing that would make "is the LLM coach better" answerable.

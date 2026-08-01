---
name: agent-context
description: What the LLM sees and when Riki speaks — `packages/context` (session preamble, rolling snapshot, coaching brief, memory) and `packages/events` (salience scoring, trigger policy, interrupt gates). Use when changing the snapshot or brief format or its token budget, adding an advice topic or a brief section, or changing the rules that decide whether Riki says anything at all.
---

# Feeding the agent, and deciding when to speak

The agent never sees the raw stream, and **it cannot ask for anything**. Everything is push:

1. **Session preamble** — written once, cached. Hero pool, patch, player history, and all
   reference data, because there is no mid-match lookup path.
2. **Rolling snapshot** — ~250–400 tokens, refreshed per turn, general. This is the hot path.
3. **Coaching brief** — ~150 tokens, refreshed per turn, focused on the one thing this turn is
   *about*. `BRIEF_PLAN` maps an event id to the sections that moment needs.

> **There used to be a fourth thing and it was a *pull* surface** — `get_enemy_detail`,
> `read_screen`, a parse/admit/queue/execute/render pipeline, a manifest in the cached prefix, and
> a consent gate. [ADR-0023](../../../docs/adr/0023-coaching-replaces-command-execution.md) deleted
> all of it. If you find a reference to a tool call, a manifest, an effect class or a failure code
> anywhere in this repo, it predates that decision — fix it. The session is configured with
> `tools: []`, and a stray `response.function_call_arguments.done` is counted by
> `VoiceTelemetry.strayToolCall` and never answered.

## The snapshot format is an interface

It is the interface to the LLM, so treat a format change like an API change: it goes through
`fixtures/golden/`, and the diff is the review. Rules that hold in the renderer:

- **Never render a stale CV fact as a bare fact.** A 30-second-old position must carry its
  age and confidence, visibly, in the rendered text. Presenting a guess as certainty is the
  worst outcome the product has.
- **Below-threshold facts are dropped, not hedged.** Hedging spends tokens to say nothing.
- **Budget is enforced by priority truncation**, not by hoping. Test the truncation order —
  what survives when the budget is tight is a design decision, not an accident.

## Trigger policy — invisible until needed

The default is silence. `packages/events` scores salience and then has to clear gates
before anything reaches the agent:

- **Not during a teamfight.** Riki talking over a fight is worse than Riki saying nothing.
- **Not while the player is speaking.**
- **Cooldown and novelty gates.** Saying a true thing for the third time is noise.
- **"Only when I ask" mode must actually be silent** — it is a supported configuration, and
  it defaults off but is asserted by test.

When you change scoring, add the case to the suppression tests. The failure mode here is not
a crash; it is a product that people turn off.

## The coaching brief — what a moment needs

`packages/context/src/coaching/`, spec in `docs/design/coaching-architecture.md` §4–§5. Four rules,
each easy to break in a way that looks fine:

- **`BRIEF_PLAN` lives in `packages/context`, not `packages/events`.** Section priority interacts
  with the token budget, and the salience path must never acquire a reason to know about tokens.
  Events names the moment; context decides what it is worth rendering. The table keys on event ids
  written as **string literals**, which is why the content half could ship before `packages/events`
  existed at all.
- **Position in a plan row is priority, and the lead section is undroppable.** A brief either
  carries the thing the trigger fired on or renders nothing — there is no middle state where the
  model holds context for advice it can no longer justify.
- **A brief that renders nothing is a turn that does not happen.** `CoachingBrief.empty` is a
  value, not an exception; the composition root closes the turn `'silent'`. Nothing on this path
  throws, and nothing is appended to the ledger for an empty brief — a zero-token entry would make
  "had nothing to say" and "said nothing about it" look the same in the record.
- **A section does no arithmetic and formats no age itself.** Any comparison — farm against a
  benchmark, a window against the clock — is a `derived.*` field from `packages/world-model`, and
  `field()` is the only path from an `Observed<T>` to the text. Both rules are the snapshot's, and
  a brief section that breaks either produces a number with no age and no confidence sitting next
  to numbers that have both.

Adding an advice topic is **one detector file in `packages/events`, one arm on `CoachEventKind`,
and one row in `BRIEF_PLAN`**. Two files, two packages, no existing module changes behaviour. That
cheapness is deliberate and is the one genuinely good property of the deleted tool registry.

Adding a brief *section* is one file in `coaching/sections/`, a mention in whichever plan rows want
it, and one golden diff. The plan mention is the part not to skip: **a section no plan row names
never renders, and nothing fails** — `plan.test.ts` asserts both directions for exactly that.

## Memory — the window is a cache, not a record

The model's context window truncates oldest-first, cannot be enumerated, and dies with the session
(realtime §5). So `packages/context` keeps a **conversation ledger** and treats the window as a
cache of its tail (ADR-0012). Four rules follow, and each is easy to break in a way that looks fine:

- **If something must survive a compaction or a reconnect, it goes in the ledger.** The novelty
  gate, the coaching record and the post-match summary all read the ledger, never the conversation.
- **Retention drops a tool result and its call together, always.** Dropping the result alone leaves
  the model looking at a question it asked and never got an answer to — the exact vacuum the
  one-result invariant exists to prevent, reintroduced from the other end.
- **Summaries are rendered, never generated.** The world model already holds the kills, timings and
  net-worth curve; the ledger holds the advice. A template costs nothing, cannot invent a kill, and
  works when the session is already unhealthy — which is when compaction happens.
- **Nothing durable holds free text.** `PlayerObservation` is a closed union of ids and enums
  (ADR-0013), so chat and transcripts are not representable rather than merely not written. If you
  add an arm with a `string` that is not an id, the privacy test fails, and that is the design
  working.

`AgeFormatter` in `render/` is the *only* function that turns an `Observed<T>` into words. Do not
format an age locally, in either tier — one function is what makes "never render a stale fact as a
bare fact" enforceable rather than remembered.

## Latency

Model → snapshot is budgeted at under 5 ms. The snapshot is rendered per turn, so anything
expensive belongs in the world model's derived state, computed once, not in the renderer.

**The brief shares that budget rather than adding to it.** There used to be a second, ~1200 ms
command budget on top of a conversational latency floor realtime §7 already puts at 1–2 s — a turn
that gathered perfect detail produced a coach who answered after the fight. Brief assembly is pure
and synchronous, so the whole of a turn's context work is one <5 ms slice with nothing awaited.
**Anything that could make a brief slow is a design error, not a condition**: if a section ever
needs a network, it earns back the watchdog, the breaker and the queue that ADR-0023 removed.

## Learnings

**2026-08-01 — the preamble, the snapshot, the memory layer and the coaching brief are implemented;
the composition root is not.** `createContextAssembler()` (`src/assembler.ts`) is the runtime
surface, and `openTurn` renders the snapshot *and* the brief in one synchronous call. What has
*not* landed: the session wiring in `apps/desktop/src/main/agent/`, which needs `packages/realtime`
and `packages/events`. So
`Compactor.consider()` produces a `WindowPlan` and hands it to an injected `onWindowPlan` callback,
and nothing executes it yet. *Why:* if you are here to "hook up the window", the seam already exists
and takes a value — do not add a method to this package to make the truncation happen.

**2026-08-01 — the field paths are this package's invention, and `packages/world-model` has not
agreed to them.** `self.hpPct`, `self.kda`, `self.abilities` (a `{id, cooldown}[]`),
`derived.nextItem` (`{item, inSeconds}`), `derived.teamfightIntensity` and the rest are read as
strings through `FieldPath` and exist nowhere else. *Why:* when that package lands, the fixture
corpora tell you which names moved — grep `path('` in **both** `snapshot/sections/` and
`coaching/sections/`, which is about forty between them, all in two directories on purpose.

The brief added several that nothing supplies yet and that a `packages/world-model` task should
know are wanted: `derived.threats` (`{hero, area, etaSeconds}[]`), `derived.buybackCost`,
`derived.nextStackAt`, `derived.paceNetWorth`, `derived.paceLevel`, and
`enemies.<hero>.ultimate`. Each exists because the alternative was arithmetic inside a section,
which coaching §5.5 forbids — an absent field renders as an omitted section, which is the correct
degradation and is why they could be declared ahead of being supplied.

**2026-08-01 — `dropsWith` cannot be applied before composition, so the renderer composes twice.**
The `seen`/`unseen` pairing looks like a property of the ladder, and it is not: the composer drops
one section at a time by priority and re-measures, so it will cheerfully drop `unseen` and keep
`seen`. Which sections get dropped is not knowable until the budget has been measured against the
text, so closure is applied to `composed.omitted` and the survivors are re-composed, in a loop.
*Why:* the loop looks redundant on the way past and is the only thing making §5.2's pairing rule
true. It terminates because each pass drops strictly more, and in practice runs once or twice.

**2026-08-01 — a promotion has to move the whole drop-group, or it causes the drop it prevents.**
Promoting `seen` to the top of the droppable group without `unseen` leaves `unseen` at the bottom;
it drops first, and the closure then takes `seen` with it. Also worth knowing before you write a
fixture for it: **`enemy_missing` promotes nothing visible**, because `seen` is already the highest
droppable rung. `rune_soon` (→ `derived`) is the event to demonstrate promotion with, and
`fixtures/golden/snapshot/mid-game-rune-soon.txt` versus `mid-game-truncated.txt` is that diff.

**2026-08-01 — costing an utterance by its transcript under-reports the window by ~10×** (ADR-0021).
The conversation is audio; the transcript is a side artifact. realtime §5 prices assistant audio at
~1,200 tokens/min against maybe 120 tokens/min of text, so a ledger that counted the text would
compact far too late and the first correction would be the API truncating the cached prefix.
`memory/occupancy.ts` costs speech from a spoken word-rate instead. *Why:* it is one constant, in
one file, and it is the number §12's first row asks to be measured — if the window estimate turns
out to drift, look here before anywhere else.

**2026-08-01 — `RetentionPolicy`'s `keepLastTurns` protects conversation only, and reading it the
other way inverts the ladder.** Protecting the last N turns wholesale means the last N turns of
*command results and snapshots* are protected too — which are the first two rungs, and ~500 of the
~750 tokens a minute Riki injects (§7.1). The policy would then have almost nothing to drop and
would go straight to summarising conversation. *Why:* the ladder's order is the design; the
never-dropped set is deliberately narrower than it first reads.

**2026-08-01 — the "drop a result and its call together" rule is gone, and so is every other
ordering dependency in the ladder.** ~~One `command` ledger entry carried the call's name *and* its
result, so a ref dropped both or neither.~~ ADR-0023 deleted commands; the `brief` arm that replaced
the `command` arm supersedes *itself* the way a snapshot does. The ladder is four rungs and
**nothing on it obliges dropping anything else**, which `retention.test.ts` now asserts directly.
*Why:* if you ever add a paired entry back — two ledger entries that are only meaningful together —
you re-earn the trap, and the design called it the rule an implementation is most likely to get
wrong. Keep the pair inside one entry, as that one did.

**2026-08-01 — `FakeWorldModel` coalesced `clock: null` to 600, so the pre-horn snapshot was
untestable.** `options.clock ?? 600` treats the one value a test passes on purpose as absent. Fixed
in `src/testing/index.ts`. *Why:* general shape worth carrying — in a fake, `??` on any option
whose `null` is meaningful silently deletes the case somebody wrote the fake to reach.

**2026-08-01 — the enrichment deadline is a race, not a timeout, and the loser needs cancelling.**
`Promise.race([allSettled(requests), timer])` is what makes "a port that never resolves still
produces a preamble" true. Cancel the timer afterwards: under `ManualTimers` a pending timer fires
into whatever test runs next and reads as a flake there rather than a bug here.

**2026-08-01 — `patch_notes` is planned and unserviceable, deliberately.** `ReferenceDataPort` is
`item`/`matchup`/`benchmark` (`common/ports.ts`) — there is no patch-notes method. The
planner still emits the request the design's union declares, the fetcher has an empty case for it,
and the section renders the patch version from `PreambleInput.patch` alone without claiming to be
degraded. *Why:* adding the port method later is one case in `preamble/assemble.ts`, not a change to
three files — and if you are wondering why the section looks thin, that is why.

**2026-08-01 — anything rendered for the model is subject to three rules and two of them are
invisible from inside this package.** Written for tool results and it transferred whole to the
coaching brief: rendered text is subject to the snapshot's staleness rules (dota2 §6.2), the log
tailer's privacy tagging (state-capture §4.2, chat text is `sensitive`), *and* the Realtime context
budget. *Why:* check all three when you change what any renderer emits. The token cost used to be
the one that bit, because tool results **accumulated** in conversation history and were billed as
input on every later turn. A brief replaces itself like a snapshot, so that particular sting is
gone — which is most of why coaching-architecture.md §8.2's arithmetic came out *lower* than the
design it replaced despite adding a renderer.

**2026-08-01 — realtime §5's `retention_ratio: 0.8` is not `targetAfter`, and conflating them
compacts twice as often as intended.** They are different knobs against different triggers. 0.8 is
the *API's*, and the API fires when the window is genuinely full — so it leaves 20 % of headroom.
A local compactor fires at `lowWaterMark`, so copying 0.8 into `targetAfter` while triggering at
0.75 leaves 5 %, and every compaction re-pays full price for everything retained against an 80×
cached discount. `DEFAULT_WINDOW_BUDGET`'s 0.75 → 0.55 is the right shape and already avoids this;
the note is here because all four numbers are marked *(tunable)* and the obvious way to "tune"
`targetAfter` is to reach for the number in the research note. *Why:* verified the hard way in a
parked implementation that triggered at 0.95 and retained 0.8 — it compacted every ~3 minutes and
looked healthy, because the window never overflowed. The window not overflowing is not the goal;
not busting the cache is.

**2026-08-01 — realtime §5's "15–20 minutes" does not transfer, and the correction inverts what you
economise.** That number assumes continuous conversation at ~1,800 tokens/min of audio. Riki mostly
listens, so its audio is a fraction of that — but it injects a ~300-token snapshot and up to 600
tokens of command results *per turn*, and unlike the snapshot's role as a view, those accumulate.
Redone for Riki's pattern the total is ~750 tokens/min, of which **~500 is our own injection**,
giving roughly 38 minutes to the first compaction. *Why:* two consequences that are easy to get
backwards — compaction is a normal event in a normal-length match rather than an edge case, and the
thing to economise is what you *tell* the model, not what it says. Arithmetic, not measurement:
it is open question 11 and the first row of context-and-memory §12.

**2026-08-01 — a design doc asking for a formatting optimisation can be asking for a coupling.**
dota2 §6.2 asks the snapshot to elide unchanged fields. Working it against the retention policy
turned up that an elided snapshot is a delta, a delta needs its base to still be in the window, and
the base is exactly what compaction drops — so it is a keyframe scheme with a silent failure mode,
for an estimated ~120 tokens a turn. *Why:* the general shape is worth remembering, not the
conclusion. Before implementing anything that references a previous turn, ask what happens when
that turn has been compacted away; the answer is usually that the reference has to carry enough
information to be falsifiable, which is why the marker is now `(unchanged since 14:12)`.

**2026-08-01 — `packages/context` has several renderers and they share more vocabulary than the
first one expects.** `tools/` landed first and declared `MonoMs`, `Observed<T>`, `Staleness`,
`PrivacyPolicy` and the world-model reader itself; everything needed every one of them, so they
moved to `src/common/`. *Why:* put a type in `common/` the moment a second directory names it —
the transitional declarations all collapse into `@riki/protocol` and `@riki/world-model` later, and
one file to edit beats three. Duplicating instead is silently fine until the package index
re-exports both and `tsc` reports TS2308.

*This is not hypothetical and it bit twice.* Deleting `tools/` (ADR-0023) meant moving four things
out of it first, in **its own commit**, because `tools/testing/` was imported by every test file in
the package — deleting first turns the whole package red at once, which is the worst position from
which to work out what was load-bearing. And building `coaching/` re-declared
`UNSEEN_AFTER_SECONDS`, which TS2308 caught at the index exactly as described: it is also
`AgeFormatter`'s `unseenAfterMs`, so a second copy is a number that can drift from the one deciding
whether a position renders as an age or as `unseen >Ns`. It imports Tier 2's now.

**2026-08-01 — three learnings were deleted from this file with the code they were about.** They
concerned the command pipeline's dedup memo, its effect-class limits, and the variance problem in
its erased tool definition. All three were hard-won and all three are now about nothing; they are
in git history at `8b1a902~4` if a future pull surface ever needs them. *Why:* a learning about code
that no longer exists is worse than no learning — the next agent reads it as current and goes
looking for the file.

## See also

`docs/design/context-and-memory-architecture.md` (preamble, snapshot, memory, retention — with
three revisions marked in its header);
`docs/design/coaching-architecture.md` (the brief, `BRIEF_PLAN`, the revised budgets, and the full
record of what was deleted); `docs/design/dota2-state-capture-design.md` §6, §6.4 (trigger policy);
[ADR-0023](../../../docs/adr/0023-coaching-replaces-command-execution.md);
`REPO_SKELETON.md` §5.3 Tier 2 (golden tests), §11 item 5 (where the persona lives — open, and more
urgent now that the preamble is the only thing shaping how Riki sounds).

---
name: agent-context
description: What the LLM sees and when Riki speaks — `packages/context` (session preamble, rolling snapshot, agent tools) and `packages/events` (salience scoring, trigger policy, interrupt gates). Use when changing the snapshot format or its token budget, adding an agent tool, or changing the rules that decide whether Riki says anything at all.
---

# Feeding the agent, and deciding when to speak

The agent never sees the raw stream. It sees three tiers, and the third is pull, not push.

1. **Session preamble** — written once, cached. Hero pool, patch, player history.
2. **Rolling snapshot** — ~250–400 tokens, refreshed per turn. This is the hot path.
3. **Tools** — `get_enemy_detail` and friends. The agent asks; nothing is pushed.

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

## Tier 3 — commands the agent issues

A tool call is a *command*, and it reads what has already been observed. It never reaches into
the game (ADR-0003). The architecture is
`docs/design/agent-command-execution-architecture.md`; four rules are worth knowing before you
open it, because each is easy to break in a way that looks fine:

- **Every call is answered exactly once, within its deadline.** Nothing in the pipeline throws
  or rejects — a failure is a *result*, with text written in Riki's voice. An unanswered
  `call_id` stalls the turn, and the model's documented behaviour when a result never arrives
  is to hallucinate one (realtime §11.6). A watchdog per call, not per queue, is what makes
  the guarantee true rather than hoped for.
- **The manifest is frozen for the session** (ADR-0011). Tool definitions live in the cached
  prefix under a 16,384-token cap shared with the instructions, so withdrawing a tool when its
  source dies busts the cache. Availability is a property of the result instead.
- **A dead source degrades to an aged answer, not to silence.** "Last seen mid ~12s ago" beats
  "I can't see that" whenever the model already holds the fact. `unavailable` is for things
  never observed.
- **Commands read the world model, never a source.** No handler talks to GSI, the log tailer or
  the sidecar. `get_minimap_summary` requests a fresh pass and then waits for the model to
  change (state-capture §7.2), so every CV fact is gated and aged exactly once.

Adding a command is one handler file, one registry entry, one golden fixture — and a re-measure
of the manifest's token cost, which is the part people skip.

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

Command work has its own budget: ~1200 ms *(tunable)* per turn, all commands together. It is
*added* to a conversational latency floor that realtime §7 already puts at 1–2 s, so a turn that
gathers perfect detail produces a coach who answers after the fight.

## Learnings

**2026-08-01 — Tiers 1 and 2 and the memory layer are implemented; the composition root is not.**
`createContextAssembler()` (`src/assembler.ts`) is the runtime surface, and everything §16 lists as
steps 1–6 and 8 has landed with tests. What has *not*: step 7, the `ContextWindowPort` adapter and
the session wiring in `apps/desktop/src/main/agent/`, which needs `packages/realtime`. So
`Compactor.consider()` produces a `WindowPlan` and hands it to an injected `onWindowPlan` callback,
and nothing executes it yet. *Why:* if you are here to "hook up the window", the seam already exists
and takes a value — do not add a method to this package to make the truncation happen.

**2026-08-01 — the snapshot's field paths are this package's invention, and `packages/world-model`
has not agreed to them.** `self.hpPct`, `self.kda`, `self.abilities` (a `{id, cooldown}[]`),
`derived.nextItem` (`{item, inSeconds}`), `derived.teamfightIntensity` and the rest are read as
strings through `FieldPath` and exist nowhere else. Step 4 will either supply them or not. *Why:*
when that package lands, the fixture corpus in `fixtures/golden/snapshot/` is what tells you which
names moved — grep `path('` in `snapshot/sections/` for the full list, it is about thirty, and they
are all in one directory on purpose.

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

**2026-08-01 — the "drop a result and its call together" rule is held by the entry shape, not by the
policy.** One `command` ledger entry carries the call's name *and* its result, so a ref drops both
or neither and `packages/realtime` maps the ref back to two conversation items. *Why:* the design
calls this the rule an implementation is most likely to get wrong, and the reason it cannot go wrong
here is structural rather than careful — if you ever split that entry in two, the rule stops being
free and `retention.test.ts`'s pairing assertion is what should catch it.

**2026-08-01 — `FakeWorldModel` coalesced `clock: null` to 600, so the pre-horn snapshot was
untestable.** `options.clock ?? 600` treats the one value a test passes on purpose as absent. Fixed
in `tools/testing/index.ts`. *Why:* general shape worth carrying — in a fake, `??` on any option
whose `null` is meaningful silently deletes the case somebody wrote the fake to reach.

**2026-08-01 — the enrichment deadline is a race, not a timeout, and the loser needs cancelling.**
`Promise.race([allSettled(requests), timer])` is what makes "a port that never resolves still
produces a preamble" true. Cancel the timer afterwards: under `ManualTimers` a pending timer fires
into whatever test runs next and reads as a flake there rather than a bug here.

**2026-08-01 — `patch_notes` is planned and unserviceable, deliberately.** `ReferenceDataPort` is
`item`/`matchup`/`benchmark` (command architecture §5.3) — there is no patch-notes method. The
planner still emits the request the design's union declares, the fetcher has an empty case for it,
and the section renders the patch version from `PreambleInput.patch` alone without claiming to be
degraded. *Why:* adding the port method later is one case in `preamble/assemble.ts`, not a change to
three files — and if you are wondering why the section looks thin, that is why.

**2026-08-01 — The tool surface is where three of this repo's rules meet, and two of them are
invisible from inside `packages/context`.** Designing Tier 3 turned up that a tool result is
subject to the snapshot's staleness rules (dota2 §6.2), the log tailer's privacy tagging
(state-capture §4.2, chat text is `sensitive`), *and* the Realtime context budget — and that the
third one has no owner in this package. *Why:* if you are changing anything about what a tool
returns, check all three; the one that will bite is the token cost, because tool results
accumulate in conversation history and are billed as input on every later turn, while the
snapshot replaces itself.

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

**2026-08-01 — `packages/context` has three tiers and they share more vocabulary than the first one
expects.** `tools/` landed first and declared `MonoMs`, `Observed<T>`, `Staleness`, `PrivacyPolicy`
and the world-model reader itself; all three tiers need every one of them. They now live in
`src/common/` and `tools/` re-exports them. *Why:* if you are adding to this package, put a type in
`common/` the moment a second tier names it — the transitional declarations all collapse into
`@riki/protocol` and `@riki/world-model` later, and one file to edit beats three. Duplicating
instead is silently fine until the package index re-exports both and `tsc` reports TS2308.

**2026-08-01 — the dedup memo will deadlock on itself unless you publish *after* admission.** §6.4
wants a call registered as in-flight "before any work starts", and §4.4 makes the memo admission's
*first* check. Do both literally and every call matches its own in-flight entry and awaits its own
result: every command hangs until its watchdog fires, which reads like a queue bug and is not one.
The fix is ordering, not locking — publish immediately after the admission verdict, which is still
inside the synchronous prefix of `invoke()` (parse, resolve and `admit` are all sync), so a
duplicate arriving a microtask later still joins. *Why:* the symptom is uniform and far from the
cause, and the same trap is waiting in any "register before starting" cache whose lookup sits in the
path being registered.

**2026-08-01 — the effect class's limits are a ceiling, so a class default below any member's number
is unbuildable.** `registry.ts` enforces §3.2's tighten-only rule at construction, and it fired
immediately: §8.2 gives `get_recent_events` 200 result tokens while the `model` class default was
120. The class default has to be the *largest* number §8.2 allows any member, with narrower commands
tightening to their own. *Why:* the check is worth keeping precisely because it found this — but
read it the right way round when it fires. It is usually telling you the class default is wrong, not
that the command is.

**2026-08-01 — a single erased `ToolDefinition<never, unknown>` cannot exist, because
`ResultRenderer<R>` is contravariant in `R`.** The pipeline holds definitions monomorphically and
knows only `unknown`; under `strictFunctionTypes` no substitution makes both the handler (covariant
in its return) and the renderer (contravariant in its input) assignable at once. `defineTool()`
therefore erases by *closing over* the typed pair while the generics are in scope, and the pipeline
sees `RegisteredTool` — `decode`/`execute`/`render`, all `unknown`. *Why:* it confines the one type
assertion in the component to a place where the value provably came from the matching codec, and it
is the answer to "why is there not just one definition type?" if you are tempted to simplify it.

## See also

`docs/design/context-and-memory-architecture.md` (Tiers 1 and 2, memory, retention);
`docs/design/dota2-state-capture-design.md` §6 (all three tiers), §6.4 (trigger policy);
`docs/design/agent-command-execution-architecture.md` (Tier 3 — the pipeline, ports, failure
taxonomy and budgets); `REPO_SKELETON.md` §5.3 Tier 2 (golden tests), §11 item 5 (where the
persona lives — open).

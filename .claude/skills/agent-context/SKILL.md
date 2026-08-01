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

**2026-08-01 — The tool surface is where three of this repo's rules meet, and two of them are
invisible from inside `packages/context`.** Designing Tier 3 turned up that a tool result is
subject to the snapshot's staleness rules (dota2 §6.2), the log tailer's privacy tagging
(state-capture §4.2, chat text is `sensitive`), *and* the Realtime context budget — and that the
third one has no owner in this package. *Why:* if you are changing anything about what a tool
returns, check all three; the one that will bite is the token cost, because tool results
accumulate in conversation history and are billed as input on every later turn, while the
snapshot replaces itself.

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

## See also

`docs/design/context-and-memory-architecture.md` (Tiers 1 and 2, memory, retention);
`docs/design/dota2-state-capture-design.md` §6 (all three tiers), §6.4 (trigger policy);
`docs/design/agent-command-execution-architecture.md` (Tier 3 — the pipeline, ports, failure
taxonomy and budgets); `REPO_SKELETON.md` §5.3 Tier 2 (golden tests), §11 item 5 (where the
persona lives — open).

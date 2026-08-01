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

## See also

`docs/dota2-state-capture-design.md` §6 (all three tiers), §6.4 (trigger policy);
`docs/design/agent-command-execution-architecture.md` (Tier 3 — the pipeline, ports, failure
taxonomy and budgets); `REPO_SKELETON.md` §5.3 Tier 2 (golden tests), §11 item 5 (where the
persona lives — open).

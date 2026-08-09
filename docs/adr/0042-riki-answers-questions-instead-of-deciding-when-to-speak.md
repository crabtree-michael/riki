# ADR-0042: Riki answers questions instead of deciding when to speak

**Status:** Accepted
**Date:** 2026-08-09

**Reverses:** [ADR-0023](0023-coaching-replaces-command-execution.md), whose `tools: []` was justified by *"the facts a
turn needs are assembled before the model is asked to speak"*. That is true only while something
else has already chosen what the turn is about.

**Supersedes in practice:** the trigger ladder of
[coaching-trigger-architecture.md](../design/coaching-trigger-architecture.md) and the two-model
split of [llm-coach-architecture.md](../design/llm-coach-architecture.md).

## Context

Riki was built to interrupt well. Detectors proposed candidates on every world-model version bump, a
salience score ranked them, an intensity fold suppressed them mid-fight, and thirteen gates in a
fixed ladder decided whether any of it reached the player. Then `packages/coach` put the same
question to a language model in prose — *"the overwhelmingly common correct answer is speak:
false"* — and `coach.ts` justified the duplication as *"a cooldown is a guarantee and a paragraph is
a tendency"*.

The distinction is real. The price was not obviously worth it, and a live match on 2026-08-09 priced
it:

- 152 world-model ticks produced **one** spoken turn.
- **85** consecutive candidates were refused by gate 4, `agent_speaking`, which had armed itself when
  a turn opened and could not release because the `response.done` that clears it never arrived.
  Nothing bounded the wait; nothing reported the wedge. Riki was silent for the rest of the match and
  the only visible symptom was silence.
- Of four faults found that day, three were inside the machinery whose only job is to decide when to
  speak.

The failure mode is not incidental to the design, it is characteristic of it. A ladder of thirteen
conditions, each able to hold a turn back, has thirteen ways to hold every turn back forever. The
inspector existed largely to make that ladder legible, which is itself evidence about how legible it
was.

Meanwhile the product's actual value never depended on the interrupting. Riki can see the game state
and remember it and the player cannot: net worth against theirs while fighting, where their position
four was ninety seconds ago, whether Roshan is up. All of that is answerable on request.

The repo had already written down the bet this ADR settles. Open question 18 in
[docs/README.md](../README.md) asks:

> Does a ~150-token focused coaching brief carry as much useful signal as a tool call did? The core
> bet of ADR-0023; if it is false, either the brief grows or **some pull mechanism comes back**.

The pull mechanism comes back.

## Decision

**Riki speaks only when spoken to, and reaches the world through tools rather than through a
pre-assembled brief.**

Four properties:

1. **No unprompted speech.** Every turn has a key press behind it. `packages/events` and
   `packages/coach` are deleted, along with the brief, ledger, memory and preamble machinery in
   `packages/context` that served them.
2. **Five narrow tools**, not one blob: `my_state`, `enemy`, `objectives`, `economy`, `world_at`.
   Narrow rather than generic because a failed call in a voice conversation is not a retry, it is a
   pause in a spoken sentence — a `query(path)` surface invites the model to invent a path and find
   out mid-answer.
3. **Every returned value is a `Fact`** — value, age, confidence, source — or an explicit `unknown`.
   The type already exists and already says why; the tool layer's whole correctness obligation is to
   not flatten it on the way out.
4. **The match is recorded to disk as it plays**, and the recording is the agent's memory. `world_at`
   reads it back by seeking the nearest keyframe and replaying forward.

## Consequences

**The worst failure mode goes away by construction.** A coach that never interrupts cannot interrupt
wrongly. That was the property the thirteen gates were built to buy, and it is now free.

**`agent_speaking` is deleted, and that is not a lost safety property.** It existed to stop a
coaching trigger landing on a turn already speaking. With no triggers, nothing can land on anything;
barge-in is handled in `packages/realtime` by truncation. The gate solved a problem the trigger
engine created.

**A recorded match is a test fixture.** The repo's fixtures are already this format. The reason
2026-08-09's debugging took a morning is that no failure could be replayed; every match played now
produces the artifact that would have prevented it.

**Session renewal becomes mandatory rather than theoretical.** Observed the same day at 15:43:36:
`session_expired — "Your session hit the maximum duration of 60 minutes."` The data channel closed,
ICE disconnected, and nothing reconnected. One session per match was survivable while Riki mostly sat
quiet; it is not survivable for an assistant expected to answer at minute 61 of a long game. The new
design owes a renewal path that reopens transparently and does not lose the conversation.

**Latency moves onto the critical path.** A tool round trip now sits inside a spoken answer, where
the old design did its fetching before speaking. This is the main thing the new shape buys with, and
it is measurable rather than speculative.

**Two documents become historical.** `coaching-trigger-architecture.md` and
`llm-coach-architecture.md` describe a system that will not exist. They are kept, marked superseded,
because the reasoning in them about staleness and about what a coach should not say is the input to
the new prompt.

## Alternatives considered

**Keep the ladder, add a watchdog.** The immediate fix for the observed wedge, and it was
implemented — an open turn now has a bounded lifetime. It repairs one of thirteen ways to stall and
leaves the other twelve, and it leaves two mechanisms still answering one question.

**Keep unprompted speech, let the model decide.** Stream world deltas into the live session and let
the model interject. Strictly simpler than the ladder and it keeps the original product promise. Not
chosen *now* because it makes every tick cost tokens in an always-open session and because the pull
path has to be right before the push path is worth having. This is the natural next step, not a
rejected one.

**A few hard-coded alerts on plain timers** — Roshan up, rune spawn. Perhaps a hundred lines, and it
keeps the one class of thing a player genuinely cannot see. Deferred for the same reason: get the
core conversation right first.

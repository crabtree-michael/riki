# ADR-0047: A turn is its tool calls, and a turn without any is marked

**Status:** Accepted
**Date:** 2026-08-09

**Extends:** [ADR-0032](0032-the-inspector-observes-by-decoration.md) — the second decorator this
component installs, on the same terms as the first.
**Follows from:** [ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md), which
deleted the panels this replaces.

## Context

The inspector's centre of gravity was the gate ladder: thirteen verdicts per candidate, the deciding
refusal styled apart from the shadowed ones, and a Controls panel to move the thresholds behind
them. ADR-0042 deleted the engine, so five panels went with it and the window was left showing what
Riki *believes* with nothing about what it *does* with a question.

What replaced the ladder as the thing worth watching is named in
[conversational-architecture.md §10](../design/conversational-architecture.md):

> **The model may answer without calling a tool.** It has a plausible-sounding match in its context
> from earlier turns and no hard incentive to refresh. The prompt must make the call mandatory for
> any factual claim, and the inspector must show every turn's tool calls so a skipped call is
> visible rather than inferred from a wrong answer.

That failure has the property the gate ladder had, which is why it needs the same treatment: it is
**silent**. A turn that answered from month-old pretraining and a turn that answered from a fact
observed four hundred milliseconds ago produce the same audio, the same transcript, the same
outcome, and differ only in whether they were right. The old design's worst failure was Riki
speaking when it should not; this one's is Riki sounding certain about a number nobody measured.

## Decision

**A `DebugTurn` carries the tool calls made inside it — name, arguments, result, status and
duration — and a turn that spoke without making one is marked.**

Four things follow, and three of them are the arguable ones.

### 1. The hub decides which turn a call belongs to

`ToolDispatcher.call` is `(name, args)` and carries no turn id. The obvious fix is to add one, and
it is wrong: it would make a `packages/realtime` type aware that a debug window exists, which is the
instrumentation ADR-0032 was written to avoid. So the hub attributes each call to **the newest turn
in its buffer**, and no caller passes an id at all.

This is sound because the Realtime session runs one response at a time, so at most one turn is open
when a call is dispatched. It is knowably wrong in one case — a call whose result arrives after its
turn has scrolled out of the forty-turn ring — and that case is handled by dropping the result
rather than by attaching it to a stranger. A call that arrives with **no** turn open is recorded as
a `problem`, because under ADR-0042 every turn has a key press behind it, so a call outside one means
the session answered something nobody asked.

### 2. The no-call mark is deliberately wider than the failure

§10's failure is *a factual question answered with no tool call*. The inspector cannot detect that
one, because **it never sees the question**: `shared/debug.ts` carries `playerSaidChars` and refuses
the transcript, on the grounds that the player's speech is the one thing in this process that is
nobody's business but theirs (dota2 §7).

So the mark fires on every **spoken** turn with zero calls. "What time is it" and "say that again"
are both flagged. That trade is deliberate and it only goes one way: a false positive costs a reader
two seconds, and a false negative is the exact class of bug — an answer that sounds grounded and is
not — that nobody catches by listening. The privacy rule is not negotiable to buy precision here,
and a heuristic over Riki's *own* transcript was considered and rejected: spoken numbers arrive as
digits or as words depending on the voice model's mood, so it would miss silently and look
authoritative doing it.

An open turn is not marked. It has not answered yet, so it has not answered without asking either.

### 3. `unknown` is a status, not a failure

Every result is `{value, age, confidence, source}` or `{unknown: reason}`
([ADR-0043](0043-an-unknown-is-a-shape-not-a-null.md)). A call that came back entirely `unknown` gets
its own status beside `ok`, `refused` and `failed`, because it is the answer to a question the other
statuses cannot express: *why was that answer so vague*. It is styled amber — read this — rather
than red, which is reserved for the two statuses that mean no tool ran.

The check is **top-level only**. "The tool had nothing at all" and "three of nine fields were
unknown" are different findings, and counting the leaves would collapse them into one number that
answers neither; the second is legible in the result JSON that sits beside the row.

### 4. What is timed is what can be timed

Three legs are shown: turn open to first call, the calls themselves, turn open to answer. There is
deliberately no leg for the model's own deliberation — the gap between the key release and the first
call contains a network round trip, the model reading a snapshot, and its decision to call at all,
and nothing in this process can separate them. It is labelled "to first call" and left
un-decomposed, because a number that implies a decomposition it cannot support is worse than a
coarse one.

## Consequences

**The decorator lands before its producer, and that is the ticket order.** T9 is wave 2 and T4 — the
ticket that wires tool calling into the session — is wave 3, so `observeToolCalls` is exported,
tested against a fake dispatcher and **not yet installed by the composition root**. Wiring it is one
call in `shell/index.ts` of exactly the shape `observeSnapshots` already has. The hub API is public
alongside it for the case the decorator structurally cannot see: a call refused by `parseToolCall`
never reaches a dispatcher, and the model naming a tool that does not exist is the most interesting
thing it can get wrong.

**A frame grows, and the bound is the tool result.** Forty turns × eight calls × 800 characters is
the worst case, which is the same order as the snapshot text already carried. Overflow past eight
calls in one turn is counted into `toolsDropped` rather than silently discarded — a truncated list
that reads like a complete one is the one thing this window must never produce.

**`recordTurnClosed` takes a timestamp now.** The hub has no clock by design, and the
question-to-answer leg spans two events, so the close has to carry its own `at`.

## Alternatives considered

**Thread a turn id through `ToolDispatcher`.** Exact attribution, no inference. Rejected: it widens a
package type for the benefit of a dev-only window, which is precisely what ADR-0032 refused, and it
buys accuracy in a case (two turns open at once) that the session's own serialisation rules out.

**A separate Tool calls panel, beside Turns.** Simpler to render, and it loses the join that makes
the data worth having — the interesting object is *this question and the calls it made*, not a
stream of calls. It would also have no way to show a turn that made none, which is the finding.

**Infer "factual question" from Riki's transcript** — flag only turns where the answer contained a
figure. Narrower and more precise when it works. Rejected: the transcript spells numbers
inconsistently, so it fails by staying quiet, and a mark that silently misses is worse than one that
over-fires in a window whose whole job is to be believed.

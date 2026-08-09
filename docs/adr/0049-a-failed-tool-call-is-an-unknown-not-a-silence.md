# ADR-0049: A failed tool call is an `unknown`, not a silence

**Status:** Accepted
**Date:** 2026-08-09

## Context

[ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md) gave Riki five tools
and [ADR-0023](0023-coaching-replaces-command-execution.md)'s `tools: []` had to go with it. T2
built the manifest and the two conversions either side of a call; T3 built the tools. T4 is the
wiring, and wiring it raised three questions the tickets did not answer.

All three share a shape. A tool call happens **inside a response that is already being spoken**, so
every branch of it is a decision about what the player hears in the next second. There is no error
dialog and no retry; there is a sentence that continues, a sentence that stops, or a sentence that
says something wrong.

## Decision

**A tool call that cannot be answered is answered with `{ unknown: <reason> }`.** All four of the
ways a call fails on our side — a name outside the five, arguments the schema refuses, a dispatcher
that throws, a result the tool's own schema rejects — produce a `function_call_output` in the shape
the model already reads for a fact nobody observed
([ADR-0043](0043-an-unknown-is-a-shape-not-a-null.md)). Every result is `orUnknown(Report)`, so this
is a *valid* answer to all five tools rather than an out-of-band error, and `tools.test.ts` asserts
that validity for each of them rather than assuming it.

**The manifest is sent only when a `ToolDispatcher` is injected.** A session with no dispatcher
sends `tools: []` and counts a call it cannot answer, exactly as before ADR-0042. Availability of an
individual tool still belongs in the *result* of a call and never in the presence of the tool —
[ADR-0011](0011-tool-manifest-frozen-per-session.md)'s surviving half is untouched — but whether the
tool *layer* exists at all is a fact about the process, not about the match.

**The continuation `response.create` belongs to `TurnController`, and a cancelled turn does not get
one.** The output item is sent either way, so the conversation never carries a call with no answer;
only the continuation is suppressed.

## Consequences

A tool that throws costs the player a vaguer answer and one round trip, instead of a turn that stops
mid-sentence with no audio and nothing to act on. The model is told *why* — `detail` names the tool
and what was wrong with it — so a refused call is also the correction, and the next call in the same
turn can be right.

The cost is that a broken tool layer is **quiet**. Every call degrades politely, the answers get
vaguer, and nothing sounds wrong. That is deliberate, and it is why the rejection reason goes to
telemetry (`VoiceTelemetry.toolCallRejected`, which is what `strayToolCall` became) and why
[ADR-0047](0047-a-turn-is-its-tool-calls.md)'s inspector marks a turn that called nothing. Neither is
optional after this decision; without them the failure mode is a match's worth of confident,
ungrounded answers, which is conversational-architecture.md §10's named risk arriving by our own
hand rather than the model's.

Tying the manifest to the dispatcher means production behaviour does not change yet. The session
runs in the voice window and the world model runs in main (ADR-0002, ADR-0015), so a real dispatcher
has to cross the preload bridge — a renderer→main *request* that `schemas/voice.ts` does not have.
Until that message lands, `apps/desktop` injects nothing, `tools: []` goes out, and Riki answers from
the injected snapshot as it does today. What it also means is that the wiring ticket cannot half-land:
a dispatcher that is passed is advertised, and one that is not, is not.

The cancel rule reintroduces a small piece of state in `turn.ts` (`cancelled`, set by every path that
ends a response early and cleared at each `response.create`). It is the price of the `await` a tool
call puts in the middle of a spoken response — the one place where "the player pressed `Esc`" and "we
are about to ask for more speech" can both be true.

## Alternatives rejected

**Let the failure propagate and kill the turn.** The honest-looking option, and it is the failure
mode ADR-0042 exists to have fewer of: silence that the player cannot distinguish from a crash, a
hang, or Riki deciding not to answer. `parseToolCall` and `encodeToolOutput` were already written to
return values rather than throw, for exactly this reason; making the session throw would have wasted
that.

**A distinct error shape for our failures — `{ error: … }` beside `{ unknown: … }`.** It reads
better in a log and it is worse in a voice. The model would need a second vocabulary for "I could not
get that", prompted for and tested separately, to produce the same spoken sentence. The distinction
that matters to a player is *whether the answer is grounded*, and `unknown` already carries it. The
distinction that matters to a developer is on the telemetry and in the inspector, where a reader can
act on it.

**Always advertise the manifest, dispatcher or not.** Then a session with no tool layer answers every
call with a degraded reply, so the model is invited to call five tools that always fail — which is
strictly worse than not offering them, and it would arrive silently the moment somebody constructed a
session without one.

**`tool_choice: 'required'`.** A turn that needs no tool ("say that again", "what did you just say")
would have to refuse or invent a call. The rule wanted is *call a tool before a factual claim*, which
is a distinction only the model can draw, so it lives in the prompt (T8) rather than in the session
configuration.

**Send the `response.create` from `session.ts`, next to the dispatch.** It would put a second producer
of `response.create` in the package and make [ADR-0017](0017-server-vad-on-with-response-creation-ours.md)'s
"the gesture is the sole authority" a claim nobody checks. A continuation is not a new response, but
that is only true while something enforces it — which is what `TurnController.submitToolOutput` is.

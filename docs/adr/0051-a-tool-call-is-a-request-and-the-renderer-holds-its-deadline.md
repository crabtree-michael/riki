# ADR-0051: A tool call is a request across the preload bridge, and the renderer holds its deadline

**Status:** Accepted
**Date:** 2026-08-09

## Context

[ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md) replaced the trigger
engine with five tools. T3 wrote them, T4 wired the dispatch inside `packages/realtime`, T6 added
the timeline reader and T9 built a panel to watch the calls. All of it passed, and **none of it ran
in a real match**: the Realtime session lives in the hidden voice renderer (ADR-0010) and a
`WorldState` may only be read in Electron main (ADR-0002, ADR-0015), so `apps/desktop` injected no
`ToolDispatcher`, so `packages/realtime` sent `tools: []`, so the model was never offered a tool.

[ADR-0049](0049-a-failed-tool-call-is-an-unknown-not-a-silence.md) recorded this as deliberate and
temporary: *"until that message lands, `apps/desktop` injects nothing … and Riki answers from the
injected snapshot as it does today"*. This is that message. It was raised as T12 after a player in a
live match reported that Riki could not see their skill tree or items — the visible half of a coach
with a ~400-token snapshot and no way to ask anything else.

Three things had to be decided that ADR-0049 did not, and all three are consequences of *where* the
two halves run rather than of what a tool does.

## Decision

**`voice.tool.call` / `voice.tool.result` are a correlated request on a bridge where everything else
is one-way**, joined by a `callId` the renderer allocates. It is not the model's `call_id`: that
addresses a conversation item on the far side of the session and never crosses, because main has no
business knowing a conversation item exists. The payloads are typed as objects
(`ToolPayload`) rather than restating `schemas/tools.ts`; both ends already validate against
`TOOLS[name]` — `parseToolCall` before a call leaves the renderer, `TOOLS[name].arguments.safeParse`
in main before anything is dispatched, and `encodeToolOutput` on the result — and a third
declaration of the tool set would be the one that drifts.

**`VoiceSessionOpen.tools` carries ADR-0049's coupling across the process boundary.** That ADR ties
the manifest to the presence of a dispatcher, and the dispatcher is now on the other side of a
bridge from the session that would advertise it. So main states whether it can answer, and the
renderer builds a dispatcher — and therefore advertises — if and only if it was told yes. False is
the pre-ADR-0042 session, and it stays a supported configuration rather than an accident.

**The deadline is the renderer's, and it answers `{ unknown: … }` rather than throwing.** A tool
call is the only `await` inside a response that is already being spoken. A directive sent into a
main process that is wedged, mid-quit or simply slow produces no error of any kind, so without a
bound the promise sits inside `answerToolCall` with the response held open behind it. Two seconds,
then Riki says it cannot reach its game state — which is a sentence, in the shape `orUnknown`
already accepts, and not an exception inside a sentence.

**A tool result is answered off the renderer's directive queue.** `host.ts` serialises directives so
a turn cannot run against a half-built session. A tool result must not be serialised with them: it
is the reply to a request made from inside an `await` that an earlier handler may still be in, and
queueing it behind that handler is a deadlock in which the response never finishes and the answer
never arrives, silently, on both sides.

**A call that never reached a tool goes to the inspector and never to the chip.** `voice.tool.rejected`
carries `packages/realtime`'s refusals — a name outside the five, arguments the schema rejects — and
the renderer's own timeout. These are exactly the failures `observeToolCalls` structurally cannot
see (ADR-0047), because nothing was dispatched for the decorator to wrap.

## Consequences

The tool layer runs. A live session advertises five tools, a call crosses to main, the world model
answers it from the same snapshot the coach renders from, and the T9 panel — which had no production
caller at all — fills.

`world_at` reopens the match recording on every call. `TimelineTarget.secondsAgo` is measured from
the last line the timeline holds, so a timeline opened at `match_started` and kept would answer
about the match's opening minutes for the rest of the game while sounding entirely current. The cost
is one file read per call, on a path that runs once or twice a turn.

The deadline is a real behaviour change under load: a main process busy enough to take two seconds
to project a `WorldState` will make Riki vaguer rather than slower. That is the intended trade — the
alternative is a sentence that stops — but it means the timeout must never be tightened toward a
latency budget. It is a deadline for a wedged process.

**The renderer can now make main do work.** `voice.tool.call` is the first message on this bridge
that is a request, and a compromised or looping renderer can issue them at whatever rate it likes.
Nothing rate-limits it, deliberately: both processes are one build, the work is a bounded in-memory
projection, and a limit would be a second thing to tune. If the sidecar or a plugin ever reaches
this bridge, that stops being true and this is the paragraph to revisit.

## Alternatives rejected

**Move the world model into the renderer.** It would delete the bridge and the deadline with it, and
it is the wrong direction on every other axis: the world model is fed by a GSI listener, a log
tailer and a child process, all of which are main's, and ADR-0015 keeps the credential path there
too. The renderer would become the process that owns the game state and the microphone and the model
connection.

**A `voice.tool.call` schema that restates the five argument shapes.** Stronger validation at the
bridge, and a third declaration of the tool set. `schemas/tools.ts` exists so there is one, and the
first copy to drift would be the one nobody reads — a bridge that rejected a valid call is
indistinguishable from a model that chose not to call anything.

**Main holds the deadline instead.** It cannot: the failure worth bounding is main not answering,
and a timer in the process that is wedged does not fire. Main answering slowly is also the case
where a renderer-side deadline is *wrong* to fire, which is why the number is generous rather than
tight.

**Advertise the manifest unconditionally and let main answer `unknown` when it has no dispatcher.**
It would delete `VoiceSessionOpen.tools`. ADR-0049 already rejected the same shape one layer down,
for the same reason: five tools that always fail is strictly worse than none, and it would arrive
silently the moment somebody constructed a session without one.

**Report a refused tool call as a `VoiceFault`.** It is already a `VoiceEvent` kind and would have
needed no new message. It also reaches the overlay, and a player mid-teamfight can do nothing with
"the model asked for a tool that does not exist". ADR-0049 chose a vaguer sentence over an error
nobody can act on; putting the same information on the chip by a different route would undo that.

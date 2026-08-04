# ADR-0039: A scenario drives the real chain, and the trace shows where it stopped

**Status:** Accepted
**Date:** 2026-08-04

**Extends:** [ADR-0038](0038-a-rehearsal-is-a-turn-against-a-world-nobody-is-playing.md), which
landed the same day from the same starting point. A rehearsal asks *what would the coach say about
this state*; this asks *what does the whole app do with this state, and where does it stop*. Those
are different questions, answered by different machinery, so both mechanisms stay.

**Amends:** ADR-0038's Decision point 2, *"It cannot make Riki speak."* That property is kept for
rehearsal, where it is right, and deliberately not extended to this ADR's `scenario.speak`. The
reasoning is below, and it is the contentious part of this document.

## Context

ADR-0038 was written against a tuning problem: reaching laning phase to see what the coach says costs
a match. This ADR is written against a different one, which happened on 2026-08-03 and cost a day.

Riki drafted coaching turns for a whole match and made no sound. Every panel in the inspector said
the app was working — detections firing, salience scored, thirteen gates passing, `spoke:
stack_now:173` recorded in Coach turns. The Problems panel showed a sidecar fault, a hotkey note, and
nothing else.

The fault was four layers below any of it. `parseClientSecret` read the Realtime session id from a
field the GA API had moved, fell back to `''`, and the voice renderer rejected the entire
`voice.session.open` directive as unreadable; every later `voice.turn.speak` then no-opped against an
undefined session and never returned `responseEnded`, which is what leaves `agent_speaking` latched
on for the rest of the match. Three things made it invisible, and a rehearsal would have found none
of them:

- **The voice telemetry was four no-op arrows** in `main/index.ts`, so the `session-lost` fault
  reached nothing and the Problems panel's silence read as *nothing failed*.
- **Nothing in the app could drive the live chain.** Reaching the moment took an external script
  posting synthesised GSI frames at the socket. A rehearsal deliberately does not touch that chain.
- **Every panel is state, not sequence.** They answer *what is true now*. The only useful question
  was *what happened, in order, and where did it stop* — and nothing answered it.

Finding it took hand-instrumenting five call sites with `appendFileSync` and reading the output. The
trace was decisive on the first run.

## Decision

**The inspector records an ordered trace of the coaching chain, and can start two scenarios that
drive the real one.** Four properties:

**1. The trace is the deliverable.** A ring buffer on the hub of detect → salience → gates → coach →
session → renderer steps, in order, carrying the elapsed time from the run that produced them. It
fills whether or not anybody clicked anything: a live match traces itself.

**2. Filling it meant making the telemetry real.** The four no-op arrows now forward into the hub,
late-bound because `createVoiceSession` is constructed before the shell that owns the hub. **This is
the load-bearing half of this ADR.** The buttons make a run cheap; the telemetry is what makes a run
legible, and its absence is why a five-line fix took a day.

**3. Actions are a registry, as controls are.** `main/debug/actions.ts` holds one row per scenario,
and an `action` intent names a row. It is a second verb beside ADR-0038's `rehearse` rather than a
merge of the two, because they carry different things: `rehearse` names a mock state and builds a
scratch world around it, `action` names a row and takes no argument. Two rows:

| Row | What it does |
|---|---|
| `scenario.match` | Posts a scripted GSI sequence at our own server, exactly as Dota 2 does — pre-game, the horn, the clock walked to the first stack window at 0:53. Everything downstream is the production path. |
| `scenario.speak` | Sends one turn to the session port, skipping detection and gates, to isolate the voice leg. |

`scenario.match` reaches the app through the socket rather than through a shortcut into the bus, so
the token check, the payload parser, the session tracker and every lifecycle edge are exercised. What
"the button made Riki speak" proves depends entirely on how much of the real path the button used.

**4. `scenario.speak` may make Riki speak, and ADR-0038's refusal of that is amended.** ADR-0038
argues — correctly — that the inspector is the widest privilege surface in the app, and that the
worst failure here is Riki talking when it should not. The counter-argument is the bug above: when
the chain decides to speak and no sound arrives, the only useful next question is whether the voice
leg works at all, and the only way to answer it was to replay a whole match and listen. Two
narrowings keep the original concern addressed:

- **It carries no text of its own.** It speaks the current snapshot, rendered by the same narrator
  the LLM coach reads. There is no path from this window to arbitrary words in the player's
  headphones, which is what ADR-0038's concern is actually about.
- **It does not touch the conversation.** The narrator rather than `context.openTurn`, so nothing is
  appended to the ledger and no window budget is spent. Pressing it does not change what the model
  remembers, and the next real turn is identical for it having been pressed.

It is still an API call per press, and the row says so.

## Consequences

Two mechanisms now exist for two questions, and the window's reading order is the causal one:
Rehearsal and Scenarios above Controls, Trace beside Problems. A third scenario is a row here and an
argument in an ADR, not something somebody adds.

The scenario script walks the match clock continuously and cannot be compressed to make the button
faster: `packages/gsi` raises `clock_discontinuity` beyond five seconds of drift, and a discontinuity
resyncs the world model — clearing the latch set and the cooldown clocks the run exists to exercise.
That bound is asserted by test, as is the fact that each of the run's four captions actually fires:
the first draft keyed two of them on an equality that could never hold, and printed two of four.

The trace is a ring buffer in memory, dropped on exit — a debugging aid, not a log. When
`packages/telemetry` lands, the hub's trace sink is the obvious second consumer of whatever that
package emits, and the no-op object this ADR deletes is the shape of what that package should
replace.

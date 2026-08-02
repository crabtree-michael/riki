# ADR-0032: The inspector observes by decoration, and can change nothing

**Status:** Accepted
**Date:** 2026-08-02

## Context

Riki is built to fail quiet. Eight detectors run on every world-model version bump, one candidate
wins a ranking, thirteen gates get a veto, and the overwhelmingly common outcome is silence — which
is the design (dota2 §6.4). The consequence is that **a working Riki and a broken Riki look
identical from outside**, and until now nothing could tell them apart at runtime:
`fixtures/golden/` covers six moments somebody wrote down in advance, `TriggerCounters` aggregates a
whole match into per-kind and per-reason totals, `onSuppressed` reports the winner's *first*
refusing gate one event at a time, and `console.*` is confined to `packages/telemetry`, which is a
skeleton — so `nullTelemetry()` is where every fault the app reports currently goes.

Building a window that answers "what does Riki believe, and why did it stay quiet" needs access to
three things the process does not expose: the losing candidates and the twelve gates that passed
(discarded inside `policy.decide`), the engine's latch set and cooldown clocks (private to
`createEventEngine`, correctly — they are its invariants), and the snapshot and brief as rendered
(returned to the agent, which composes and forgets them).

The obvious way to get all three is to add hooks: an `onTick` to `EventEngine`, an accessor for the
latches, an `onTurn` to `CoachingAgent`. That is instrumentation, and it puts debug-only code on the
path whose failure mode is Riki talking when it should not.

Long form: [`docs/design/debug-inspector.md`](../design/debug-inspector.md).

## Decision

**The inspector observes exclusively by decorating collaborators the composition root already
injects, and every decorator returns its delegate's value unchanged.** `TriggerPolicy` is wrapped on
its way into `createEventEngine`, `RikiContext` on its way into `createCoachingAgent`, and
`ShellTelemetry` on its way into everything. `packages/events`, `packages/context`, `packages/coach`
and `main/agent/` are unchanged by the feature.

It is a **separate window, off by default** (`config.debug.enabled`), and **read-only by
construction**: `RikiDebugBridge` has two methods, `ready` and `fault`, and there is deliberately no
way to set a switch, force an evaluation or replay a tick from it.

## Consequences

**What it buys.** Every gate's verdict on every ranked candidate, per tick — information that exists
nowhere else in the process, including inside `packages/events`, because the policy discards it
between the ranking and the return. The engine's private state arrives free on the same
`GateContext` the gates are handed. Both coaches are covered by one wrap of the assembler, and the
LLM coach's declines arrive through `ShellTelemetry`, which it already reports to (ADR-0031) — so
adding the second coach's coverage needed no change to `packages/coach`.

**What it costs.** Thirteen gate calls per candidate per version bump instead of at most thirteen in
total; two of the thirteen project the conversation ledger. That is why the flag defaults to off and
why the cost is stated in the header of `observing-policy.ts` rather than discovered.

`observeContext` is spread-and-override, which is correct only while `createContextAssembler`
returns a plain record of own enumerable members. A getter added to `RikiContext` would break it —
so `observing-context.test.ts` asserts every key of a real assembler survives the wrap, which turns
the assumption into a test failure rather than a silent one.

**What it forecloses.** The inspector cannot drive anything, so "reproduce this tick" and "force a
turn" are not available from it and would each be a new decision, not an extension. Making it
writable would also make it the widest privilege escalation in the app, since it is the one renderer
a person can focus and type into.

**What the default protects.** With the flag off, no hub is built, so no rendered snapshot, brief or
coach transcript is held in memory at all. That makes the default a privacy decision as much as a
performance one, which is why `repo-hygiene.test.ts` asserts `RIKI_DEBUG=off` alongside
`RIKI_CAPTIONS` and `RIKI_UNPROMPTED`. The player's transcript is never carried in a frame at any
setting — only its length.

## Alternatives rejected

**Hooks on `EventEngine` and `CoachingAgent`.** Fewer moving parts and a smaller diff, and rejected
because it puts debug-only branches on the trigger path. A hook is also strictly weaker: an
`onTick(decision)` can only report what `decide` returned, so the losing candidates and the passing
gates would still be gone. The decorator gets them because it sits where they still exist.

**A panel inside the overlay.** The overlay is transparent, click-through, unfocusable, always-on-top
and budgeted to appear within 100 ms; it cannot hold a scrollable inspector, and the product promise
is that the visible surface stays invisible until needed. A second window costs one preload entry
and keeps both surfaces honest about what they are for.

**Writing frames to a log file instead of a window.** Would need `packages/telemetry`, which is a
skeleton, and a log is the wrong shape for the question: the gate ladder is a grid, and the useful
operation on it is *look at the current one*, not *grep the last hour*. The hub is nonetheless
usable headlessly — `DebugSurfaceDeps.windows` is optional, which is the shape `shell.test.ts` and a
future `pnpm dev:replay` use — so a file exporter remains cheap to add later.

**Restating `SuppressionReason` and `CoachEventKind` in `shared/debug.ts`.** `shared/` may not
import `@riki/*` (eslint.config.js), so exact unions would mean hand-maintained copies of a
thirteen-member and an eight-member union. The frame carries plain strings instead, and
`observing-policy.test.ts` asserts every member of the real unions reaches a frame — which is the
check a copied union would only look like it was providing.

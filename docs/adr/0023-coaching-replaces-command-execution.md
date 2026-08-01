# ADR-0023: Proactive coaching replaces agent command execution

**Status:** Proposed
**Date:** 2026-08-01

## Context

Riki's Tier 3 was a *pull* surface: the rolling snapshot stays small, and when the agent needs
detail it issues a function call — `get_enemy_detail`, `read_screen` — which
[`agent-command-execution-architecture.md`](../design/agent-command-execution-architecture.md)
turns into an answer through a parse/validate/admit/queue/execute/render pipeline. It is built:
~5,460 lines in `packages/context/src/tools/`, a `ToolCallPort` seam in `packages/realtime`, and
the overlay's `Acting` and `Confirming` states, which exist for nothing else.

The product it was built for has changed. Riki is to be a coach that **volunteers** advice, not an
assistant that answers questions. Under that model the agent does not need a way to ask, because
the thing that decided a moment was worth speaking about already knows what facts that moment
needs — and can assemble them in-process, before the model is asked to say anything.

Keeping the pipeline "in case it is useful" is the expensive option, not the cheap one: every
command is a permanent tax on the cached prefix (ADR-0011), the watchdog and one-result invariant
exist only because an unanswered function call stalls a voice conversation, and `read_screen` is
the only thing in the product that needs a consent surface.

Long-form reasoning, the full deletion inventory and the replacement architecture:
[`coaching-architecture.md`](../design/coaching-architecture.md). The trigger half is being built in
parallel against a sibling document, `coaching-trigger-architecture.md`; that document owns
detection, salience and the gates, and `coaching-architecture.md` §6.6 records the four places the
two designs had to be reconciled.

## Decision

We delete the agent command execution system in its entirety — `packages/context/src/tools/`, the
`ToolCallPort` seam and manifest handling in `packages/realtime`, the overlay's `Acting` and
`Confirming` states, and the design document — and replace it with a proactive coaching path.
`packages/events` decides *whether and why* Riki speaks (detection, salience, and five gates);
`packages/context/src/coaching/` decides *what the model is shown for that reason* — a focused,
budgeted **coaching brief** rendered from the world model through the existing `render/`
primitives. The seam between them is a list of `BriefSectionId`s declared in an advice catalogue,
which is the same one-file-per-capability extension point the tool registry had.

**Nothing is repurposed and nothing is kept alongside.** The pipeline, registry, manifest, queue,
executor, handlers, effect classes and failure taxonomy are removed in full — no part of the system
survives in another form. Four pieces of pre-existing shared infrastructure that merely *live* in
the `tools/` directory, because Tier 3 landed first and was briefly the only tier, move out to
`common/` and `testing/` first as their own commit: the shared test fakes (used by every test in
the package), `ReferenceDataPort` (used by preamble enrichment), `Timers` (used by the enrichment
deadline), and `CapturePort` (owned by `state-capture-architecture.md` §4.3 and implemented by the
Rust sidecar). None of the four mentions a call, an argument or a deadline. The wrapper that did —
`FreshCaptureRequest` — is deleted with the rest.

## Consequences

**What it buys.** 2,000 tokens of cached prefix back, against a cap three things share. The 1,200 ms
turn deadline disappears, because brief assembly is in-process under the snapshot's 5 ms budget.
An entire class of reliability machinery becomes unnecessary — watchdog, one-result invariant,
circuit breaker, per-effect-class concurrency, turn-scoped memoisation, barge-in cancellation of
in-flight calls, and a ten-code failure taxonomy. The retention ladder loses its one order-dependent
rule (a dropped result had to drop its call). And with `read_screen` gone, nothing Riki does needs a
permission prompt, which makes ADR-0003 structurally true rather than true by policy — and closes
open question 9. Open question 10 is closed the same way: the command queue does not exist.

**What it costs, and this is the real one.** The agent loses the ability to ask for anything it was
not given. Item costs, per-hero detail beyond the snapshot, clock-current benchmarks and — the one
that is not recoverable — an on-demand fresh CV pass of the minimap. Reference data moves entirely
into preamble enrichment at draft, a broad brief covers player-initiated turns, and the persona must
say when it does not know; none of that fully closes the gap, and
[`coaching-architecture.md`](../design/coaching-architecture.md) §3.2 states it rather than
mitigating it away.

**What it forecloses.** Adding a topic that needs a mid-match lookup now costs a port, a deadline, a
failure path and probably a watchdog. That is deliberate: the deterministic version should have to
lose an argument first.

**What it raises.** dota2 §6.4 already warns that unprompted speech is the feature most likely to
make Riki annoying enough to uninstall. Making it the primary path raises the stakes on every gate,
which is why the quiet trigger ships with a conservative default and why the local `quiet-mode`
phrase — parseable without the model — becomes the most important control in the product.

**On acceptance**, this supersedes [ADR-0011](0011-tool-manifest-frozen-per-session.md) (there is no
manifest), [ADR-0018](0018-argument-schemas-from-a-local-declaration.md) (there are no arguments) and
[ADR-0019](0019-get-build-benchmark-is-reference-class.md) (there are no commands; the fact it
records survives as a brief-assembly constraint). It strengthens [ADR-0003](0003-read-only-observation-only.md),
and makes [ADR-0012](0012-conversation-ledger-is-ours.md) more load-bearing — the ledger becomes the
only record of what advice was given.

**Two claims are unverified and decide whether this is right**: that a ~150-token focused brief
carries as much useful signal as a tool call did, and that proactive coaching at the default
thresholds is welcome rather than irritating. Neither can be settled by a test; both need a replay
harness and a person, which is why the tuning ticket is last rather than first.

## Alternatives rejected

**Repurpose the pipeline — turn handlers into advice producers.** Superficially attractive: the
ports, the renderer and the failure taxonomy are all there. Rejected because the pipeline's shape
is wrong for push. Its central abstraction is a *call* with an id, arguments, a deadline and a
guaranteed reply; a coaching brief has none of those, and every one would have to be faked. The
result would be a queue with one lane, a watchdog over synchronous code, and a registry of things
nobody calls — the cost of the abstraction with none of the reason for it.

**Keep the tool surface for player-initiated turns only.** The narrower version: delete proactive
duplication, keep the pull path for when the player asks. Rejected because it keeps everything
expensive about the design — the manifest tax on every turn's cached prefix, the watchdog, the
consent surface, the barge-in cancellation — to serve the secondary path, and because a manifest
frozen per session (ADR-0011) cannot be sized for "only sometimes".

**Put coaching in its own `packages/coach`.** Rejected on the argument
`context-and-memory-architecture.md` §2.2 already makes: nobody can enforce a ceiling on a resource
they can only see a third of. The brief is a third claimant on the same conversation window as the
snapshot and the conversation, and a separate package would need its own `AgeFormatter` — which is
how two renderers end up disagreeing about whether to say "probably".

**Put the whole coaching module in `packages/events`.** Rejected because it would give the salience
path a reason to know about tokens, which is the same inversion the deleted design refused for
commands. Events names sections; context renders them.

**Delete the code but leave the design document as history.** Rejected: `docs/` is reasoning that
is meant to be acted on, and a document describing a subsystem that does not exist will be found by
an agent who assumes it does. The reversal is recorded here and in the `Status` field of the three
superseded ADRs, which is what those fields are for.

# ADR-0014: Sources emit observations; fusion is a pure reducer

**Status:** Accepted
**Date:** 2026-08-01

## Context

Three live sources feed one world model: GSI at 2–8 Hz, a console-log tailer, and a CV sidecar in
another process. The obvious shape is for each source to update the model it knows about — the GSI
listener writes health and gold, the sidecar writes enemy positions. That shape puts three writers on
one mutable structure, makes precedence a rule each source has to remember, and makes the model
untestable without starting a listener.

The design also has to survive sources being added and removed. `dota2-state-capture-design.md` §5
and §9 both assume sources come and go at runtime — degradation sheds CV entirely, a heartbeat miss
drops GSI to nothing — so any coupling between a source and the model becomes a lifecycle problem.

## Decision

A source's only output is an `Observation`: a timestamped, sequence-numbered batch of *candidate*
facts. It never writes to the model, never reads it, and does not import it. One `FusionReducer` —
a pure function of `(state, observation, now, policies)` — decides what an observation changes, and
one `WorldModelStore` owns the only mutable state. `packages/world-model` performs no I/O and reads
no clock; time arrives as a parameter.

Sources and the model meet at types in `packages/protocol` and nowhere else. Lint rules enforce
both directions.

## Consequences

- Precedence, confidence gating, and ageing exist in exactly one place. A source cannot bypass them,
  because it has no way to reach the model.
- Fusion tests need no fixtures, no listener, and no fake clock — construct a state, apply an
  observation, assert the next state. This is where most of the subsystem's logic lives, and it lands
  in the cheapest test tier as a result.
- Adding a source is four files and changes no existing behaviour; removing one at runtime is not a
  lifecycle problem, because nothing holds a reference to it.
- It costs an allocation and a copy per update that direct writes would avoid. At 2–8 Hz against a
  sub-millisecond budget this is not a real cost, and it buys immutable snapshots that any number of
  readers can hold safely.
- It forecloses a source that *needs* to see current state to decide what to emit. If one appears,
  it must be split: the deciding half moves to the composition root, which may read snapshots.
- Moving fusion to a worker thread later is mechanical rather than a rewrite, which is the main
  reason purity is worth insisting on now.

## Alternatives rejected

- **Each source writes the fields it owns.** Three writers, precedence duplicated in three places
  and silently divergent, and a model that cannot be constructed in a unit test.
- **Sources emit resolved state rather than candidates.** Makes each source decide whether it beats
  the others, which is the one decision that has to be global.
- **An event-sourced log replayed on read.** Correct and much slower to query; the model is read at
  turn boundaries where latency is user-visible. The ring history in
  `state-capture-architecture.md` §5.8 gives the useful part without the cost.

See [state-capture-architecture.md](../design/state-capture-architecture.md) §2 and §5, and
[dota2-state-capture-design.md](../design/dota2-state-capture-design.md) §4.

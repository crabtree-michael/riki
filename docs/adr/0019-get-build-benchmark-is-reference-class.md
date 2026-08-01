# ADR-0019: `get_build_benchmark` is a `reference` command, not a `model` one

**Status:** Superseded by [ADR-0023](0023-coaching-replaces-command-execution.md)
**Date:** 2026-08-01
**Superseded:** 2026-08-01

> **There are no commands, so there is no effect class to argue about.** ADR-0023 deleted agent
> command execution.
>
> **The fact this ADR records survives the classification that carried it**, and it is worth
> keeping in front of whoever builds the next thing that wants benchmark data: it comes from
> `ReferenceDataPort`, it is an external, disk-cached, patch-keyed lookup, and **it cannot answer
> inside a per-turn budget**. That is now a brief-assembly constraint. Benchmarks are fetched once
> at draft into the preamble (`coaching-architecture.md` §5.3) and the comparison reaches a brief
> as a `derived.pace*` field already computed by `packages/world-model` — never as a lookup on the
> hot path, which is exactly the mistake this ADR was written to correct.

## Context

`agent-command-execution-architecture.md` §3.2 — deleted with the system it described — gave every
command exactly one effect class, and the class — not the command — decided concurrency,
deadline, consent, caching and behaviour under degradation. That table lists `get_build_benchmark`
under `model`, whose deadline is **20 ms** because a `model` command is "a memory read wearing a
promise".

But the same document's §5.3 puts `benchmark(hero, at)` on `ReferenceDataPort`, alongside `item()`
and `matchup()`; §16 step 5 schedules it with the reference-class handlers; and §3.2 gives the
`reference` class a 400 ms deadline precisely because it is an external, patch-keyed, disk-cached
lookup. A command cannot be both.

The conflict is not cosmetic. §3.2 also establishes that a definition may **tighten** its class's
limits and never loosen them, so there is no per-command override that rescues a `model`-class
`get_build_benchmark`: it would be given 20 ms to complete a disk-or-network fetch and would answer
`timeout` essentially always — a command that is advertised in the manifest, taxes the cached prefix
for the whole session, and can never succeed.

## Decision

`get_build_benchmark` is `reference` class, and declares `needs: ['world', 'reference']`. It reads
the player's net worth and level from the world model, fetches the benchmark through
`ReferenceDataPort`, and returns the comparison.

## Consequences

- It gets the 400 ms deadline and the concurrency-2 lane it needs, and a reference API outage
  degrades it to `unavailable` like the other two reference commands rather than to a misleading
  `timeout`.
- The `model` class is now exactly the three commands that are genuinely in-process reads, which
  makes the class's 20 ms deadline honest.
- §3.2's table in the design doc is now wrong in one cell. A footnote there points here rather than
  the table being rewritten, because the table is otherwise the normative statement of the classes
  and editing an approved design doc's substance is a heavier act than recording a correction.
- The comparison arithmetic lives in the handler rather than in `packages/world-model`. That is
  deliberate: it is not a fact about the match, it is a fact about the match *and* a benchmark, and
  fusing an external benchmark into the model would give the model a reason to know it is feeding an
  LLM (state-capture §7.3).

## Alternatives rejected

- **Keep it `model` and let the definition override the deadline.** Forbidden by §3.2's
  tighten-only rule, and rightly: if a command can buy itself a longer deadline, the class no longer
  decides the five things it exists to decide.
- **Split it into two commands** — one reading self-state, one fetching the benchmark — leaving the
  comparison to the model. That spends two round trips and two tool definitions on one question, and
  invites the model to do arithmetic it is bad at on numbers whose ages it cannot see.
- **Read it from the world model as a derived fact.** Would require fusing external API data into
  match state; see the last consequence above.

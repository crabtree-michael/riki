# ADR-0024: Suppression is counted; the ledger records transitions

**Status:** Accepted
**Date:** 2026-08-01
**Accepted:** 2026-08-01, with the implementation of `packages/events` and the composition root.

## Context

`coaching-architecture.md` §6.3 makes one demand of the trigger half, and it is the right one:

> every refusal is recorded, so that "Riki said nothing" is never indistinguishable from "Riki
> noticed nothing".

Two documents then say how. `coaching-architecture.md` §13's testing map asks that *"every refusal
appends `turn_closed: 'silent'` and increments its own `SuppressionReason` counter"*, and
`context-and-memory-architecture.md` §3.3 introduces the `turn_closed: 'silent'` ledger entry for
exactly this purpose. Read literally, that is **one ledger entry per refused trigger**.

Implementing it literally is wrong, and the reason is arithmetic rather than taste.

`packages/events` evaluates on every world-model version bump. GSI POSTs at 2–8 Hz (dota2 §2.1), so
a 45-minute match is on the order of **twenty thousand evaluations**, and in any match where
something is detectable at all — a hero unseen, an ult up, a rune approaching — most of them end in
a refusal. Against that:

- ADR-0012 sizes the ledger at *"a few hundred entries and a few tens of kilobytes"* and says
  explicitly that it *"is not a data structure that needs care"*. Twenty thousand entries makes it
  one.
- Worse, it is quadratic. `CoachingMemory` is a projection over `ledger.all()`, memoised against
  `ledger.version()`, and **every append bumps that version**. The novelty gate reads the projection
  on every evaluation, so a per-refusal append means re-walking a growing array on every tick. The
  gate that exists to keep Riki from repeating itself would become the most expensive thing in the
  per-turn budget, and it would get slower as the match went on.

The counters have no such problem: they are thirteen integers.

## Decision

**The per-reason counters carry the fine-grained accounting; the ledger records transitions.**

`EventEngine.counters()` increments exactly one `SuppressionReason` for every refusal, with no
deduplication, and that is the number `coaching-architecture.md` §12 row 2 is asking for. The
composition root additionally appends one `turn_closed: 'silent'` entry per **change** in
`(reason, DetectionKey)` — that is, the moment Riki started being quiet for a new reason about a new
thing — and appends nothing while that stays the same.

What survives in the ledger is therefore the shape of the silence rather than its every instant: the
moment the player said "only when I ask", the moment a fight started suppressing advice, the moment
a topic went onto its cooldown. That is what anybody reading the record is looking for, and it is
what survives a compaction and a reconnect, which is the only reason the ledger is involved at all
(ADR-0012).

## Consequences

**The demand in §6.3 is met and its stated mechanism is not.** "Riki said nothing" and "Riki noticed
nothing" stay distinguishable — by two artefacts instead of one, and the more precise of the two is
the counters. Anyone tuning thresholds should read `counters()`; anyone reconstructing a match should
read the ledger.

**One assertion in `coaching-architecture.md` §13 is now wrong as written** and this ADR is the
correction. The test that replaced it asserts both halves separately: every refusal increments
exactly one counter, and five identical refusals produce one ledger entry rather than five.

**The counters are in-process and die with the match.** They are a value on the engine, not a
telemetry surface; `coaching-trigger-architecture.md` §15 item 5 leaves that open, and until it is
settled the tuning signal is only readable from a test or a replay harness. That is enough for §16
step 8, which is the only consumer that exists.

**A refusal that changes and changes back re-appends.** `quiet_mode` → `high_intensity` →
`quiet_mode` is three entries, not two, because the dedupe compares against the last append rather
than against a set. That is deliberate: a set would make the record depend on how long ago something
happened, and the entries are cheap.

## Alternatives rejected

**Append per refusal, as written.** Rejected on the arithmetic above. It is worth noting that the
cost is not the storage — it is that `CoachingMemory`'s memo is keyed on the ledger version, so the
appends defeat the memoisation that makes the novelty gate cheap. That coupling is not obvious from
either document, which is most of why this ADR exists rather than a code comment.

**Sample: append every Nth refusal.** Rejected because the sample rate would have to be tuned against
the GSI rate, and a record whose completeness depends on how fast the game client is POSTing is worse
than either alternative — it looks complete and is not.

**Keep suppression out of the ledger entirely, counters only.** Tempting, and it is what the
performance argument alone would suggest. Rejected because the counters die with the process and
`turn_closed: 'silent'` is the only thing that survives a session loss and a compaction — and dota2
§6.4's failure mode is a coach that has been quiet for nine minutes without anyone noticing. A
transition record is small enough to keep and is exactly the part that answers that.

**Give `packages/events` the ledger and let it decide.** Rejected: it would put a `ConversationLedger`
write inside a function that runs on every version bump, and the edge between the two packages is
deliberately `CoachingMemoryReader` — three methods about advice, and nothing about entries
(context-and-memory §6.3). Events names what happened; the composition root decides what is recorded.

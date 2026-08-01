# ADR-0012: Riki keeps its own conversation ledger; the model's context window is a cache

**Status:** Accepted
**Date:** 2026-08-01

## Context

Every other kind of state in Riki has somewhere to live. Facts live in the world model, decisions
live in the trigger policy, commands live in the registry. What Riki has *said*, and what the player
said back, has had nowhere except the Realtime session's own conversation — and
[`openai-realtime-research.md`](../research/openai-realtime-research.md) §5 says three things about
that conversation which together make it unusable as a record:

- It **truncates oldest-first** when the window fills, and does not summarise or compact.
- It gives no queryable account of what it dropped.
- It dies with the session, and the API has a 60-minute session cap.

None of that would matter if the window were roomy. It is not.
[`context-and-memory-architecture.md`](../design/context-and-memory-architecture.md) §7.1 redoes
realtime §5's arithmetic for Riki's actual usage pattern — a coach that mostly listens, speaking
about once a minute, but injecting a ~300-token snapshot and up to 600 tokens of command results on
every turn — and gets **roughly 38 minutes to the first compaction**, dominated by our own context
injection rather than by conversation audio. Dota's median match is shorter than that and its long
tail is not. Compaction and reconnection are both normal events in a normal match.

Three features depend on remembering across exactly the boundary the window forgets at. dota2 §6.4's
novelty gate — *don't repeat advice the player already acted on, or that they ignored twice* — is
the one that matters most, because dota2 §6.4 also names unprompted repetition as the thing most
likely to make Riki annoying enough to uninstall. A coach that forgets what it said twenty minutes
ago, or forgets everything the moment a session drops, will repeat itself precisely when the player
has had the most chances to get tired of it.

## Decision

`packages/context` keeps an append-only **conversation ledger**, one per match, in memory. Every
turn appends what caused it, which snapshot went out, what was said in both directions, which
commands ran, and whether the turn ended in speech or silence. The ledger is the source of truth for
what Riki knows it has said.

The model's context window is treated as a **cache of the tail of the ledger**. This component
computes a `WindowPlan` — what should leave, and what summary should replace it —
and hands it to `packages/realtime`, which owns the mechanism. What the API actually drops is
reported back and reconciled against our belief.

Coaching memory (which advice topics have been raised, and whether the player acted on them) is a
lazy projection over the ledger, memoised against its version — the same relationship derived state
has to the world model in `state-capture-architecture.md` §6, deliberately, so that "what happens to
it at compaction" has an answer rather than a bug.

## Consequences

- **The novelty gate is correct across compaction and reconnection**, which is the point. It reads
  coaching memory, not the conversation.
- **Reconnect becomes recoverable.** The preamble is re-assembled byte-identically and a rehydration
  brief is rendered from the ledger, so a Riki that lost its session does not repeat twenty minutes
  of advice.
- **Compaction becomes something we schedule** rather than something the API does to us. That
  matters because oldest-first truncation would remove the *cached prefix* — the persona and the
  match preamble — and keep the most recent small talk. Whatever else happens, we must reach the
  budget before the API does.
- **Summaries can be rendered rather than generated** (§7.4), because the ledger plus the world
  model already hold the structured facts. No tokens, no latency, no hallucinated kills, and
  golden-testable.
- **We hold a duplicate, and duplicates diverge.** Our belief about window occupancy is an estimate
  from an injected token counter. If it drifts, the "keep the last six turns" guarantee and the
  elision base both become wrong. This is the real cost. It is mitigated by reconciliation
  (§7.6) — `packages/realtime` reports actual drops, real usage is compared against our estimate,
  and an API-initiated truncation is recorded as a bug rather than a condition — and the underlying
  claim is listed as unverified in §12.
- **The ledger contains free text**, including the player's voice transcript and possibly other
  players' chat. It therefore does not persist by default; `RIKI_LEDGER_PERSIST` is a debug flag
  with the same treatment dota2 §7 gives debug frame capture.
- One more thing to keep in sync between two packages, and a plan that has to be executed faithfully
  by the other one.

## Alternatives rejected

- **Read the conversation back from the session.** The API does not offer an enumerable, stable view
  of what survived truncation, and even if it did, the answer would be gone with the session. A
  memory that silently forgets cannot back a gate whose entire job is not forgetting.
- **Let the API truncate and accept the loss.** Oldest-first means the first thing lost is the
  cached prefix: the persona, the draft, the player's history. Riki would forget who it is before it
  forgot what it just said.
- **Put the memory in `packages/events`, where the novelty gate lives.** Coaching memory is a
  projection of the conversation, and moving a projection away from its source gives two copies of
  "what Riki said" that diverge the first time a compaction or a reconnect touches one. It would
  also give the salience path a reason to know about tokens — the same inversion that keeps
  `BRIEF_PLAN` on the context side of the coaching seam (`coaching-architecture.md` §4.4).
- **Persist the ledger by default so post-match review is free.** It holds the player's own voice
  transcript. That is a product decision with a privacy consequence and it is listed as open
  (§15.1), not assumed.
- **Summarise old turns with a model call.** Considered and rejected for the match narrative: we
  already have the structured facts, and a generated summary costs tokens and latency, can invent a
  kill, and is least reliable exactly when compaction is most needed. Left open for conversational
  *texture* only (§7.4), via an out-of-band response.

See [context-and-memory-architecture.md](../design/context-and-memory-architecture.md) §6.2 and §7.

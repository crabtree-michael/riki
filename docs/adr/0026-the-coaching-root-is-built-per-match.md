# ADR-0026: The coaching root is built per match, not per app

**Status:** Accepted
**Date:** 2026-08-01

## Context

Wiring the coaching root into the Electron lifecycle (REPO_SKELETON §10 step 6) forced a question
that the design documents had left implicit: **how long does a `ContextAssembler` live?**

The answer is not free either way. Three of its collaborators are explicitly per-match — the
conversation ledger is one match's record ([ADR-0012](0012-conversation-ledger-is-ours.md)), the
coaching memory reasons in game clock and is the novelty gate's only input
(context-and-memory §6.3), and the Tier 1 preamble is assembled once on `match_started` and frozen
for the match — byte-identically re-assemblable on a reconnect, which is why it is frozen rather
than rebuilt (context-and-memory §4.1). And `createContextAssembler`
takes `matchId` as a construction argument, so there is no per-match seam inside it to reach for.

Meanwhile the state subsystem, the overlay, the tray and the hotkey are unambiguously app-lifetime:
the GSI listener has to be bound before there is a match to detect, and the tray has to answer *is
Riki running* when Dota is not.

## Decision

`createRikiShell` builds a `MatchRuntime` — the event tape, the `ContextAssembler`, the
`EventEngine` and the `CoachingAgent` — on `match_started`, and disposes it on `match_ended`.
Between matches `shell.match` is `null` and no coaching root exists. Everything else is constructed
once, at app start.

The `CoachingSessionPort` is deliberately on the *app* side of that line, and so is the
`VoiceBridge` that turns its events into chip state: push-to-talk is not gated on being in a match
— only unprompted speech is, by gate 1 (`not_in_match`) — so a turn the player asked for in the
menu still has to produce a chip.

## Consequences

Nothing has to remember to reset. A fresh object cannot carry last match's ledger entries, latched
detection keys, cooldown timestamps or advice topics into the next game, which is the failure mode
the novelty gate is least able to detect: stale advice records are indistinguishable from recent
ones once they are in the map.

The order is load-bearing and easy to get wrong. `buildStateSubsystem` resets the world model
*before* it announces `match_started`, because the listener that builds the runtime reads the world
model, and reading the previous match's facts is exactly the wrongness state-capture §6.4 exists to
prevent. There is a test for the ordering alone.

What it costs:

- **Durable memory has to outlive the runtime**, or ADR-0013's whole point is lost. The
  `PlayerMemoryStore` is therefore constructed once per app and passed into each match's assembler,
  and it is flushed on `match_ended` as well as on shutdown.
- **A match with no `match_ended`** — a crash, an alt-F4, a GSI stream that simply stops — leaves
  the runtime alive until the next `match_started` disposes it. Harmless, because gate 1 refuses
  everything in the meantime, but it does mean `shell.match` being non-null is not a reliable
  answer to *is a match in progress*. `state.matchId` is.
- **Anything that wants to observe across matches cannot hold the runtime.** Tuning
  (coaching-trigger §16 step 3) reads `EventEngine.counters()`, which now resets per match. A
  cross-match view has to accumulate outside, at the shell.

## Alternatives rejected

**One assembler for the app, reset on `match_started`.** Needs a `reset()` that remembers every
piece of state that exists today and every piece added later. The bug it invites — one field
missed — is silent and only shows up as advice about a hero the player is no longer playing.

**One assembler per app with `matchId` passed per turn.** Would mean the ledger and the coaching
memory are keyed by match internally, which is a larger change to `packages/context` than the
problem justifies, and it puts a match identifier on the hot path of a component whose whole job is
to be a pure function of a snapshot.

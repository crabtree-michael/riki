# ADR-0011: The command manifest is frozen for the life of a session

**Status:** Superseded by [ADR-0023](0023-coaching-replaces-command-execution.md)
**Date:** 2026-08-01
**Superseded:** 2026-08-01

> **There is no manifest.** ADR-0023 deleted agent command execution, so nothing is advertised to
> the model and there is no list to freeze. The 2,000 tokens this ADR was budgeting are back
> (`coaching-architecture.md` §8.1), and the cached prefix now holds the persona and the preamble
> and nothing else.
>
> **The reasoning below is not wrong, and one part of it outlived the decision**: a session's
> cached prefix must not be rewritten mid-match, whatever is in it. That constraint now applies to
> the preamble alone, which is why `PreambleAssembler.assemble` is required to be byte-identical
> across a reconnect (`context-and-memory-architecture.md` §4.4).

## Context

The agent's commands — `get_enemy_detail`, `get_minimap_summary`, `read_screen` and the rest of
dota2 §6.3 — are advertised to the model as tool definitions in `session.update`. Two facts about
the Realtime API decide what we may do with that list afterwards
([`openai-realtime-research.md`](../research/openai-realtime-research.md) §1, §5): the definitions
share a **16,384-token cap** with the session instructions, and they sit in the **cached prefix**,
where a change rewrites the prefix and invalidates the cache for the rest of the session.

Riki's sources fail constantly and by design. The vision sidecar crashes and restarts, GSI goes
quiet, the degradation controller sheds CV regions under frame-time pressure (dota2 §5). The
obvious response — withdraw `get_minimap_summary` from the tool list while vision is down, add it
back when it recovers — would rewrite the cached prefix on every one of those transitions, across a
35–45 minute match.

## Decision

The manifest is computed once, when the match session opens, and frozen for its lifetime.
Availability is expressed in the **result** of a command, never in the presence of the command. A
command whose port is down stays advertised and answers with aged facts, or with `unavailable` if
nothing was ever observed. Only configuration that is known before the session opens — `RIKI_VISION=off`,
`read_screen` disabled — changes the set, and it changes it before there is a session to update.

## Consequences

- The cached prefix survives a match. Source churn costs nothing in tokens or latency, which is
  the point.
- Every command is a permanent tax on the prefix whether or not it is ever called, so the manifest
  gets a token ceiling (2,000, tunable) asserted by a Tier 1 test. Adding a command means
  re-measuring. That is deliberate: without the number, the tax is invisible.
- The model is sometimes told about a capability that cannot currently answer. It finds out by
  asking, which costs a round trip. This is the real cost of the decision, and it is accepted
  because the alternative costs a prefix rewrite instead — and because "I can't see the minimap
  right now" is a sentence a coach says, while a tool silently vanishing is not something the model
  can observe or explain.
- The failure taxonomy has to be good, since it now carries all of the availability information.
  `agent-command-execution-architecture.md` §7.1 and §7.2 are load-bearing for this ADR: the
  default answer under a dead source is aged facts, not an error.
- Manifest assembly becomes a pure function of config, testable with no session.

## Alternatives rejected

- **Update the tool list on every degradation transition.** Correct-looking and expensive: it
  invalidates the prompt cache on exactly the events that happen most often, and realtime §5 names
  cache-busting as the cost and latency cliff of a long session.
- **Advertise the union and let calls fail with an exception.** Same manifest, worse failures — an
  unanswered or thrown call stalls the turn, and the model's documented behaviour under a missing
  result is to hallucinate one (realtime §11.6).
- **Two sessions, one per degradation mode.** A new session loses the conversation and pays the
  preamble again. The player would hear it.
- **Advertise only the always-available commands and never the vision ones.** Throws away the
  capability that dota2 §2.2 exists to provide, on the basis of a failure that is usually transient.

This rests on the claim that a mid-session `session.update` with a changed tool list busts the
cached prefix, which is read from the API's caching documentation and **has not been measured
here**. `agent-command-execution-architecture.md` §12 lists it as the check that would relax this
decision to a preference.

See [coaching-architecture.md](../design/coaching-architecture.md) §8.1 for where those 2,000
tokens went. `agent-command-execution-architecture.md`, which this ADR cites throughout, was
deleted with the system it described.

# ADR-0046: A no-argument `enemy()` answers for everyone

**Status:** Accepted
**Date:** 2026-08-09

Settles open question 1 of [conversational-architecture.md](../design/conversational-architecture.md)
§11, which [ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md) T2 left open
on purpose because the shape in [ADR-0043](0043-an-unknown-is-a-shape-not-a-null.md) admits both
answers.

## Context

`enemy(hero?)` takes an optional hero name. The design asked:

> Does `enemy()` with no argument return five summaries or refuse and ask which hero? Five
> summaries is more useful and more tokens.

T2 built a shape that settles neither. `EnemyResult` is `EnemiesReport | UnknownFact`, and
`EnemiesReport` is always a list: five summaries is a list of five, one hero is a list of one, and a
refusal is the `UnknownFact` branch carrying the question to ask. Both were implementable without
touching `packages/protocol`, which is why the decision landed here rather than there.

The trade the question names — usefulness against tokens — is real but is not where the weight
turned out to be. What decided it is that this tool is called *inside a spoken turn*.

## Decision

**`enemy()` with no argument returns every enemy hero observed so far, in the same per-hero shape a
named call returns.** No summarised variant, and no clarifying question.

Four reasons, in the order they mattered.

**A refusal manufactures the exact failure the tool surface was designed around.** §4 gives one
reason for five narrow tools rather than a generic `query(path)`: *"a failed call is not a retry, it
is a pause in a spoken sentence."* A tool that could have answered and instead asks which hero
creates that pause deliberately, in a turn the model has already begun speaking. The model's options
from there are both bad — put the clarifying question to the player, who asked "where are they?" and
did not want a form to fill in, or pick a hero itself and answer a question nobody asked.

**The five-hero question is the common one.** "Where are they?", "is it safe to push?", "can I go
rosh?" — none of those names a hero, and all of them are answered by the roster. Refusing the
natural phrasing puts the common case on the slow path and the rare case on the fast one.

**The cost is bounded, and it was measured.** Serialised against the T2 fixtures in
`fixtures/protocol/tools/`:

| Case | Size |
| --- | --- |
| One fully-observed hero (`result-enemy.json`) | 612 B |
| Five heroes at that density | 3.0 kB |
| Five heroes in the roster, nothing else observed | 1.7 kB |
| No enemy observed at all — the outer `unknown` | 37 B |

Two things follow. The expensive answer is the one where the tool has genuinely learned five heroes'
worth of things, which is the case where the model needs all of it. And the early match — where a
refusal would have saved the most — is already the cheapest answer the tool gives, because with an
empty roster there is nothing to summarise and the outer `unknown` says so in 37 bytes. The 1.7 kB
middle row is the price of ADR-0043's reason strings repeating across five heroes; that is what
honesty costs, and it buys a model that can tell "nobody looked" from "nobody was there".

**A refusal is indistinguishable from a broken tool.** `EnemyResult`'s unknown branch means "there
is nothing to answer with". Spending it on "I could have answered and chose not to" teaches the
model that an `unknown` is worth retrying or working around — which is precisely the habit that
makes it state a guess when a real unknown comes back. The branch is worth more kept narrow.

## Consequences

**The per-hero shape does not shrink for a no-argument call**, despite design §4's wording ("omit
the argument for all five, *summarised*"). That word predates T2's single `EnemyReport`. A field
present when you name a hero and absent when you do not is a field whose `unknown` has two meanings
— "nobody looked" and "you didn't ask properly" — and the model cannot tell them apart. That is
ADR-0043's flattening, reintroduced through the argument list, and it would be invisible. If the
3.0 kB row above ever becomes a real cost, the fix is a narrower *tool*, not a shape that varies by
how it was called.

**The list is sorted by hero name, not by recency.** Most-recently-seen-first is the more useful
order and is the wrong one: two calls in one turn would return the same five heroes in two different
orders, which reads to the model as the world having moved when only the sort key did. Every entry
carries its own age, so the model can order them itself and can see that it is doing so.

**A name that is not in the roster is not reported as absent from the match.** An enemy enters
`state.enemies` by being observed, so an unmatched name has two explanations — the hero is not in
this game, or nothing has read the draft yet — and "there is no Puck in this match" is one short
sentence from being a confident lie. The unknown reason says what was not observed and names the
enemies that were, so the model can correct itself without another call.

**Hero-name matching normalises case, spaces, hyphens and GSI's `npc_dota_hero_` prefix, and stops
there.** Aliases (`nevermore`, `magina`, `wr`) are hero reference data; they live in
`packages/context`'s hero library, and `packages/world-model` may not import it (ADR-0014, and the
lint rule that enforces it). A half-copied alias table in the world model would be a second source
of truth for hero identity that drifts silently. Until a resolver exists somewhere both packages can
see, an alias misses and the model is handed the observed roster — a recoverable answer rather than
a wrong one.

## Alternatives

**Refuse and ask which hero.** Rejected above. Worth noting it is not cheaper in the case that
matters: the early match already answers in 37 bytes, and by the time five heroes have been observed
the model is mid-teamfight and asking a clarifying question is at its most expensive.

**Return a reduced summary for the no-argument call** — say, position and level only. Rejected as a
shape that varies by how it was called; see Consequences.

**Cap the list at the *n* most recently seen.** Rejected: it silently answers a different question
from the one asked, and the heroes it would drop are the ones nobody has seen — which is exactly the
set a player asking "where are they?" is worried about.

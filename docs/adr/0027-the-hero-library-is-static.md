# ADR-0027: The hero library is static content, and nothing refreshes it

**Status:** Accepted
**Date:** 2026-08-01

## Context

[`hero-library.md`](../design/hero-library.md) gives the coaching brief a source for the knowledge
the world model does not have: what a hero *usually* does, where its power spikes sit, and how to
play against it. There were two ways to source that content, and the choice decides how much of this
system exists at all.

The live route — a web search behind a patch-keyed disk cache with a background refresher — was
designed in full before it was rejected. Two findings from
[`web-search-providers.md`](../research/web-search-providers.md) turned it down:

- **It can never be synchronous.** Measured p95 for a search API is ~3.5 s, and even a vendor's own
  generous numbers are 210 ms typical and 420 ms on longer queries, before any extraction. A brief is
  rendered inside the same <5 ms budget as the snapshot.
- **No self-serve provider permits the cache in writing.** Brave forbids storing or caching results
  outside "transient storage" explicitly; Tavily's terms are silent, which is the absence of a
  prohibition rather than a grant. A cache whose legal basis is silence is a poor foundation for the
  one component holding every note the product speaks aloud.

The first finding matters more under the current architecture than under the one it was first written
against. [ADR-0023](0023-coaching-replaces-command-execution.md) deleted the command pipeline, and
`coaching/contracts.ts` records what that bought: **the brief must not be able to make a turn slow**,
and the reason the pipeline needed a watchdog, a breaker and a queue was that a command could reach a
network. A live hero library would earn all three back, for one section.

Against that: a competent player can write the content down, and it stays true for a patch.

## Decision

The hero library is **static content, authored once and shipped in the repo**. Twenty top-tier heroes
at patch 7.41e, in `packages/context/src/reference/hero-library/`, read by the `library` brief
section and by nothing else.

It exports a pure function, not a port — a frozen array and a `filter`. There is no scheduler, no
fetcher, no cache, no invalidation, nothing async and **no network at runtime**. General web search
remains an *authoring* tool: it is how the roster and the notes were researched, and it is not a
capability the product has. The patch the content was written against ships with it and is rendered
with every line it produces.

## Consequences

- **Nothing leaves the machine.** `dota2-state-capture-design.md` §7 asks that cloud egress be
  enumerable; this adds nothing to the list. The prompt-injection surface of third-party web text
  does not exist here either, because no text we did not write ever reaches the model.
- **No key, no breaker, no queue, no provider terms question, and no async.** The section cannot time
  out, cannot be rate-limited and cannot be down, so it cannot reintroduce what ADR-0023 removed.
- **Its only failure is a coverage gap**, and that is the common case rather than the edge: twenty
  heroes are covered and ten are drafted. The section renders nothing and says nothing about it — a
  brief is not a conversation, so there is nobody to apologise to.
- **It decays, silently, and nothing in the system will tell you.** This is the real cost and it is
  not hidden. Three things bound it: the content is shape rather than numbers — no cooldowns, no gold
  values, no clock timings — so it degrades gracefully instead of becoming false; every line carries
  the patch it was written for; and the roster-selection rule is written down in `hero-library.md`
  §2, so re-running it is an afternoon rather than an excavation.
- **Content quality is bounded by one author on one date.** The mitigation is omission: heroes and
  mechanics that could not be described accurately were left out rather than guessed at, because a
  confidently wrong note read aloud in a coach's voice is worse than no note. A test asserts the
  parts of that policy which are structural — no digits, no Facets, one speakable line.
- **The seam is narrow enough to replace.** `searchHeroLibrary(library, query)` takes the library as
  an argument, so a live implementation is a different value behind the same call, and the section,
  the plan rows and the golden fixtures do not move.

## Alternatives rejected

- **Live web search at advice time.** Rejected on the two findings above: it buys freshness that
  matters roughly once a patch, at the cost of a cache with an unresolved terms basis, a network
  dependency in the advice path, and an injection surface — and, under the current architecture, a
  watchdog and a breaker that were deliberately deleted. If it is ever revisited,
  `web-search-providers.md` is the provider analysis, and the shape it has to take is a cache filled
  out of band, never a fetch inside a turn.
- **Baking the library into the session preamble.** Twenty heroes of notes in the cached prefix is
  paid for on every turn of every match whether or not one of them is relevant, to serve the ten in
  the game. As a brief section it costs one line, on the rows that ask for it, when the draft
  contains a hero it covers.
- **A `packages/reference` of its own.** Proposed while the live design was, on the grounds that an
  HTTP client and a disk cache would end `packages/context`'s ability to run its suite with no
  network, no filesystem and no key. With static content there is neither, and `eslint.config.js`
  still forbids `fs`, `path` and `http` in this package — which is the ban that fires if that ever
  stops being true.
- **A free-text query.** A ranking pass over free text was built first and removed: across six
  one-line notes it beat `topic` at nothing, and any query that missed degraded to priority order,
  which is what the search now does in one step. Under a proactive brief the argument is sharper —
  nothing outside `packages/context` chooses what the library is asked, because nothing outside it
  asks.
- **Covering the full roster.** Quality before cost: coverage of an off-meta hero is thin, and the
  author's reliable knowledge runs out well before 120 heroes. `hero-library.md` §2 records the
  twenty and the rule that picked them.

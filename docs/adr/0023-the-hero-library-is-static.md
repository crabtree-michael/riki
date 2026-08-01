# ADR-0023: The hero library is static content, and nothing refreshes it

**Status:** Accepted
**Date:** 2026-08-01

## Context

[`hero-library.md`](../design/hero-library.md) gives the agent one command, `search_hero_library`,
for the knowledge the world model does not have: what a hero *usually* does, where its power spikes
sit, and how to play against it. There were two ways to source that content, and the choice decides
how much of this system exists at all.

The live route — a web search at advice time, behind a patch-keyed disk cache with a background
refresher — was designed in full before it was rejected. Two findings from
[`web-search-providers.md`](../research/web-search-providers.md) are what turned it down:

- **It can never be synchronous.** Measured p95 for a search API is ~3.5 s against the `reference`
  effect class's 400 ms deadline, and even a vendor's own generous numbers are 210 ms typical and
  420 ms on longer queries, before our own extraction and rendering.
  [ADR-0019](0019-get-build-benchmark-is-reference-class.md) established that the tighten-only rule
  means no per-command override buys a longer deadline. So a live library is necessarily a cache
  plus a background refresher rather than a search — which is most of its machinery, and all of its
  failure modes, for content that changes about once a patch.
- **No self-serve provider permits the cache in writing.** Brave forbids storing or caching results
  outside "transient storage" explicitly; Tavily's terms are silent, which is the absence of a
  prohibition rather than a grant. A cache whose legal basis is silence is a poor foundation for the
  one component that holds every note the product speaks aloud.

Against that: a competent player can write the content down, and it stays true for a patch.

## Decision

The hero library is **static content, authored once and shipped in the repo**. Twenty top-tier
heroes at patch 7.41e, in `packages/context/src/reference/hero-library/`, reached by
`search_hero_library` through `ReferenceDataPort.heroLibrary()`.

There is no scheduler, no fetcher, no cache, no invalidation and **no network at runtime**. General
web search remains an *authoring* tool — it is how the roster and the notes were researched — and is
not a capability the product has. The patch string the content was written against ships with it and
is rendered, non-droppably, with every result.

**The command's vocabulary is closed with it.** `search_hero_library` takes `hero` (resolved to a
canonical id through the shared alias table) and an optional `topic` from a six-value enum. There is
no free-text argument. A ranking pass over free text was built first and removed: across six
one-line notes it beat `topic` on nothing, and any query that missed degraded to priority order,
which is what the search now does in one step. Keeping the shape costs nothing here and is worth
holding — a free-text argument is a channel whose contents are whatever the model decided to type,
and the day this library stops being local is the day that matters. The property is asserted against
the JSON Schema in the manifest, which is what the model is actually shown.

## Consequences

- **Nothing leaves the machine.** `dota2-state-capture-design.md` §7 asks that cloud egress be
  enumerable; this component adds nothing to the list. The prompt-injection surface of third-party
  web text does not exist here either, because no text we did not write ever reaches the model.
- **No key, no breaker, no warm queue, no provider terms question.** The command cannot time out,
  cannot be rate-limited and cannot be down. Its only failure is a coverage gap.
- **That gap is the common case, not the edge**: twenty heroes are covered and ten are drafted, so
  most heroes the agent asks about have no entry. It answers `unavailable` with a sentence a coach
  would say, distinct from the resolver's `unknown_subject` for a hero not in the match at all.
- **It decays, silently, and nothing in the system will tell you.** This is the real cost and it is
  not hidden. Three things bound it: the content is shape rather than numbers — no cooldowns, no
  gold values, no clock timings — so it degrades gracefully instead of becoming false; every result
  carries the patch it was written for; and the roster-selection rule is written down in
  `hero-library.md` §2, so re-running it is an afternoon rather than an excavation.
- **Content quality is bounded by one author on one date.** The mitigation is omission: heroes and
  mechanics that could not be described accurately were left out rather than guessed at, because a
  confidently wrong note read aloud in a coach's voice is worse than no note.
- **The seam survives the decision.** `heroLibrary(query)` takes the *query* and returns ranked
  notes rather than taking a hero and returning an entry, so a live implementation could rank
  server-side and replace the static one without touching the command, the renderer or the tests.

## Alternatives rejected

- **Live web search at advice time.** Rejected on the two findings above: it buys freshness that
  matters roughly once a patch, at the cost of a cache with an unresolved terms basis, a network
  dependency in the advice path, and an injection surface. If it is ever revisited, the shape it has
  to take is a cache plus an out-of-turn refresher — never a search inside a turn — and
  `web-search-providers.md` is the provider analysis.
- **Baking the library into the session preamble.** Twenty heroes of notes in the cached prefix is
  paid for on every turn of every match whether or not one of them is relevant. Behind a command it
  costs one manifest entry and nothing else until it is called, which is precisely what Tier 3 is
  for.
- **A `packages/reference` of its own.** Proposed while the live design was, on the grounds that an
  HTTP client and a disk cache would end `packages/context`'s no-network test story. With static
  content there is no client and no cache, so the argument evaporates:
  `packages/context/src/reference/` is content plus a pure function over it, which is what that
  package already is throughout.
- **A free-text `query` argument** to rank notes within a hero. Built first and removed: over six
  one-line notes it beat `topic` on nothing, and any query that missed degraded to priority order —
  which is what the search now does in one step. It also carried a manifest cost of ~33 tokens on
  every turn of every session, and the argument the model cannot get wrong is the one that is not
  there.
- **Covering the full roster.** Quality before cost: coverage of an off-meta hero is thin, and the
  author's reliable knowledge runs out well before 120 heroes. `hero-library.md` §2 records the
  twenty and the rule that picked them.

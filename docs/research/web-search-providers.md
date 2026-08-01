# Web search providers — what their terms actually say about caching

**Question asked:** could Riki source hero coaching knowledge from a *live* web search — and the
deciding criterion was never price. It was whether we may **cache results to disk for the length of a
patch and read them aloud**, because a search that cannot be cached cannot be used in an advice path
at all (§4.2 is why), and a provider that forbids caching makes the whole shape unbuildable.

**Answer: no, not on self-serve terms, and not fast enough.** Both halves failed independently:
nobody grants caching in writing (§2, §3), and measured latency is an order of magnitude over the
budget (§4.2). Together they are why
[ADR-0023](../adr/0023-the-hero-library-is-static.md) makes the hero library **static, hand-authored
content** with no runtime network at all. General web search remains an *authoring* tool.

**Read this before proposing a live version.** If the question is reopened, Tavily is the provider
to start from and §3 is the narrow reason — which is narrower than "their terms permit it", and
should not be quoted as clearance.

**Researched:** 2026-08-01. Terms change; the dates and quotes below are what to re-check.

---

## 1. The short version

| Provider | May the customer cache results? | Price | Measured latency | Verdict |
|---|---|---|---|---|
| **Brave Search API** | **No**, in writing, on every self-serve plan | $5 / 1k, 50 QPS, $5/mo free credit | not measured | **Disqualified** for v1. The only provider that grants storage *expressly* — but only on a custom plan |
| **Tavily** | Terms are **silent**; the restrictions are on redistribution and resale, not on storage | $0.008 / credit PAYG; **1,000 credits/month free** | p95 ~3.5 s third-party, ~1 s average | **Chosen** (§3) |
| **Exa** | **Unverified.** Terms are a PDF with a subsetted-font encoding that does not extract | $7 / 1k searches + $1 / 1k pages | not measured | Not chosen. The fallback to re-examine if Tavily fails |

Nobody on self-serve terms grants caching in writing. That is the actual state of the market and it
is the thing this note exists to record, because the obvious assumption — that a search API sold to
AI developers expects results to be stored — is wrong at least once and expensively.

---

## 2. Brave: an explicit prohibition

From the Search API terms of service:

> "Customer shall not…store, cache, or create a database of Search Results, in whole or in part,
> other than transient storage required for operation of Customer Applications"

A 14-day patch-keyed cache is not transient storage. There is no reading of §5.1 that survives this.

Brave's documentation elsewhere says that "if you would like to store the API results in part or
whole… you will need to subscribe to a plan that explicitly grants storage rights", and the public
plan list — Search ($5/1k, 50 QPS), Answers, Enterprise — does not contain such a plan by name. It
is an Enterprise conversation.

Two other clauses matter if anyone revisits this:

- Results may not be used to "create, evaluate, train, re-train, fine-tune, benchmark or otherwise
  improve artificial intelligence models". Reading a snippet aloud through a model is not training a
  model, but it is close enough to the line that it would want a lawyer's eye and not an engineer's.
- Attribution is permitted, not required: "Customer **may** provide attribution", and if we do it
  must be "POWERED BY BRAVE" plus the logo, conspicuously. A voice assistant has nowhere
  conspicuous to put a logo, which is its own small argument.

**The one genuinely useful thing here:** Brave is the only provider found that will grant storage
rights *expressly and in writing*. If Riki ever needs written clearance rather than the absence of a
prohibition — before a paid GA, or if someone asks the question in a security review — Brave
Enterprise is the known path, and this note is where that started.

---

## 3. Tavily: silence, and why that is enough for v1 specifically

The terms were searched for *cache, caching, store, storage, retain, retention, database, archive*.
What came back concerns **Customer Input**, not the results returned to us:

- §9.2 grants Tavily a broad licence "to collect, host, use, access, view, store, copy, display,
  create derivative works of, delete, and otherwise process **Customer Input**".
- §6.5 lets Tavily "use, process, analyze, and retain Customer Input submitted to the AI
  Functionality".
- §3.4 disclaims responsibility for backing up Customer Input.

**No clause restricts what the customer may do with the results.** The restrictions that exist are
about redistribution: the API and its key "may not be transferred, assigned, shared, or otherwise
made available to any third party" (§2), and the customer may not "license, sublicense, resell,
distribute, lease, rent, lend, transfer, assign or otherwise dispose of the Services" (§3.2).

### 3.1 The load-bearing part: who the customer is

That redistribution clause is the one that would kill this, and the reason it does not is a decision
already made for a different reason. Under
[ADR-0006](../adr/0006-env-var-api-key-for-alpha-beta.md) the **player supplies their own API key**
from the environment; Riki does not proxy a shared key through a service we run. So for
`RIKI_SEARCH_API_KEY` the player *is* Tavily's customer, Riki is the "Customer Application", and
the cache is that customer's own copy of their own results on their own disk. There is no third
party and nothing is redistributed.

**This is conditional, and the condition should be written down where someone will hit it:** if Riki
ever ships a hosted key — a free tier we pay for, a proxy, anything that makes us the customer and
the player a downstream recipient — §2 and §3.2 apply directly and this analysis has to be redone
from the top. That is not a hypothetical; ADR-0006 says it expects to be superseded.

### 3.2 What "silence" is and is not

Absence of a prohibition is not express permission. This note is not clearance, and it should not be
cited as though it were. What it is: a defensible position for an alpha where each player uses their
own key against a service whose terms do not forbid the use, with a named upgrade path (§2) for the
moment that stops being good enough. The design doc's §13.6 question — whether we may capture a
fixture corpus of real responses into the repo — is **not** covered by any of this, because a
committed corpus is redistribution by any reading. See §6.

---

## 4. Two findings that change the design

Neither was the question being asked, and both are worth more than the answer.

### 4.1 Tavily returns page content in the search call, so we do not need a crawler

`/search` takes `include_raw_content` (cleaned HTML as markdown or text) and returns per result:
`title`, `url`, `content` (a short description), `score`, and `raw_content` when asked. It also takes
`include_domains` — up to 300 — and `max_results` (0–20), and `search_depth` of
`ultra-fast | fast | basic | advanced` (1 credit; `advanced` costs 2).

The live design specified "search, then fetch at most 2 from a domain allowlist,
then extract". **That second step disappears.** One request replaces it, which removes from the
project: an HTTP client for arbitrary third-party hosts, robots.txt handling, a user-agent policy,
HTML-to-text extraction, and the redirect and timeout handling around all of it.

It also removes a privacy surface nobody had costed. With our own fetcher, Riki connects directly to
whatever host a search engine named, from the player's IP, during a match. With this, Riki talks to
exactly one host, ever.

`include_domains` implements §5.3's allowlist server-side, which is where it belongs.

### 4.2 Measured latency confirms the design's central claim

This is the live design's claim **C1** — that a search cannot fit in the 400 ms
`reference` deadline — and A5, the assumption the whole design rests on:

- Third-party benchmarks put Tavily's **p95 at ~3.5 s** (fastCRW, 100 queries) and **~3.8–4.5 s**
  in another comparison; average latency ~998 ms (AIMultiple, 2026).
- **Tavily's own claims**, which are the generous reading: 90 ms for `ultra-fast` on the simplest
  queries, **210 ms on typical evaluation queries, 420 ms on longer ones**.

Take the vendor entirely at its word and the typical case is 210 ms against a 400 ms budget, with
extraction and rendering still to pay for, and the longer-query case is already over. Take the
independent numbers and it is off by an order of magnitude at p95.

**C1 is confirmed, and A5 holds.** The search cannot happen inside a turn, and that is now measured
rather than assumed.

*Caveat on the sources:* fastCRW sells a competing product and its benchmark should be read as
directional, not neutral. AIMultiple's is the more independent of the two. Both agree on the shape,
which is the only part the conclusion needs.

---

## 5. Cost, which turns out not to matter

The design bounds worst-case traffic at **~375 requests per patch** (§7.3: 25 heroes × 5 topics,
one search per cell, and — after §4.1 — no separate fetches, so it is closer to **125**).

Tavily's free tier is **1,000 credits per month**, and `basic` costs 1 credit. **The entire
worst case fits inside the free tier**, with room for several patches. Pay-as-you-go is $0.008/credit
if it ever does not.

So cost was never the deciding factor, which is worth saying plainly because it is the factor a
provider comparison usually turns on. The deciding factor was §2 versus §3.

---

## 6. What is still open

1. **Express written permission.** Nobody grants it on self-serve. Brave Enterprise is the path if
   it is ever needed (§2). Not needed for an alpha with per-player keys (§3.1).
2. **Whether we may commit a fixture corpus** of real search responses for Tier 4 replay
   for Tier 4 replay. Nothing in §3 covers this — a corpus in a public repo is
   redistribution under Tavily §3.2 by any reading. **Recommendation: do not.** Hand-write the
   fixtures. They exist to exercise our extraction and rendering, and a hand-written fixture does
   that better anyway because it can contain the adversarial cases §6 of the design worries about,
   which a real corpus will not conveniently supply.
3. **Exa**, unverified. Its terms are a PDF whose text does not extract — the licence clause found
   by search (`…cache, store, reproduce…`) reads on inspection as the licence the **user grants
   Exa** over input and output, not one granted to the user, so it does not answer the question. If
   Tavily has to be replaced, this is where to start, and it needs a human reading the PDF.
4. **Our own latency measurement.** Everything in §4.2 is someone else's number. The first thing the
   provider adapter should do is record its own p50/p95 through `ToolTelemetry`.
5. **Rate limits.** Not documented publicly for Tavily. Discover them the polite way — the warm
   queue's concurrency of 2 is well under anything plausible, but nobody has confirmed a per-minute
   ceiling.

---

## Sources

- [Brave Search API — terms of service](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service)
- [Brave Search API — plans and pricing](https://brave.com/search/api/)
- [Tavily — terms of service](https://tavily.com/terms)
- [Tavily — search endpoint reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Tavily — FAQ (retention, pricing, latency)](https://docs.tavily.com/faq/faq)
- [Exa — terms of service (PDF)](https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf)
- [Exa — pricing](https://exa.ai/pricing)
- [fastCRW — web search API latency benchmark](https://fastcrw.com/blog/web-search-api-latency-benchmark)
- [AIMultiple — agentic search benchmark, 2026](https://aimultiple.com/agentic-search)

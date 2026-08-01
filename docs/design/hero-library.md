# The hero library

A small, static body of coaching knowledge about the heroes that matter most on the current
patch, which the agent pulls from at advice time through one command.

**Assumptions this document makes.** The reader knows the three context tiers
(`context-and-memory-architecture.md`) and the command pipeline
(`agent-command-execution-architecture.md` — the library is a Tier 3 command and nothing else).
Where those documents and this one disagree, they win; this is a content design, not a pipeline
design.

## 0. Scope, as narrowed

The original ticket left four questions open. They were answered before implementation, and the
answers are the shape of v1:

| Question | Answer | Consequence |
|---|---|---|
| Source of truth | General web search; no curated feed required | §2 records what was actually used, so the next author can repeat it |
| Update cadence | **None.** Built once, static | No scheduler, no fetcher, no cache invalidation. §5 is about living with that |
| Hero coverage | **Top-tier heroes only**, not all ~130 | 20 heroes (§2). The roster is a decision, so it is written down with its rule |
| Integration | **Not** pre-baked into prompts or config | One agent-callable command (§4). Zero cost per turn until it is called |

The fourth answer is the one that shapes the code. A library baked into the session preamble
would be paid for on every turn of every match, in the cached prefix, whether or not any of it was
relevant. Behind a command it costs only its manifest entry — a measured **159 tokens**, once,
taking the manifest from 865 to 1024 against its 2000-token ceiling — and is fetched on demand,
which is exactly what Tier 3 exists for.

## 1. What this is for

Riki's world model knows what is happening. It does not know what *usually* happens: that Spectre
is weak before her second item and inevitable after it, that Treant's lane presence is the reason
he is contested, that you do not fight Enigma without knowing where Blink is. That knowledge is
patch-flavoured but not patch-derived, it is the same in every match, and it is exactly what a
coach says out loud.

So it is reference data, in the sense `agent-command-execution-architecture.md` §5.3 already
means: *the data that is not about this match.* It goes behind `ReferenceDataPort`, alongside item
costs and matchup notes, and not into the world model.

## 2. The roster, and the rule that picked it

Twenty heroes. The rule, applied once on 2026-08-01 against patch **7.41e**:

> Rank every hero by win-rate edge over 50 % in the Ancient and Divine brackets, weighted by how
> often the hero is actually picked there, plus a bonus for professional contest rate. Take the
> top of that list, then adjust for role coverage until every position a player might be in has at
> least three heroes.

The data came from the **OpenDota `heroStats` API**, which is public, free, unauthenticated, and
reports pub picks and wins per rank bracket alongside pro picks and bans. It was preferred over
the tier-list blogs that dominate a web search for this: those disagreed with each other, quoted
win rates that did not survive contact with the bracket data, and in one case ranked a hero
"strongest mid" who is not a mid. The blogs were useful for finding the patch number and nothing
else.

Weighting by pick rate rather than taking raw win rate is deliberate: raw win rate rewards
low-pick-rate specialist heroes, and a coach who has notes on Meepo but not on Snapfire has it
exactly backwards.

| Position | Heroes |
|---|---|
| Carry | Spectre · Lifestealer · Phantom Lancer · Wraith King · Juggernaut |
| Mid | Invoker · Ember Spirit · Lina · Necrophos |
| Offlane | Night Stalker · Centaur Warrunner · Dawnbreaker · Legion Commander · Enigma |
| Support | Treant Protector · Keeper of the Light · Undying · Snapfire · Bane · Bounty Hunter |

**Heroes deliberately left out despite ranking well.** Lone Druid and Puck are heavily contested
in professional games and barely picked in pubs — their contest rate is a drafting artefact, not
advice a ranked player needs. Largo and Ring Master post-date this author's reliable knowledge;
writing notes on them would have meant inventing them, and a confidently wrong note is worse than
a missing one (§5).

## 3. Content policy — durable shape, not patch numbers

Patch 7.41 removed Facets entirely and reworked innate abilities, folding parts of each Facet back
into base kits. That happened *after* the point where this author's hero knowledge is reliable,
and it is the single best argument for the policy this library follows:

- **No numbers that a patch can silently invalidate.** No cooldowns, no damage values, no gold
  costs, no exact timings. "Spikes on her second item" is still true after a rebalance; "spikes at
  22 minutes" quietly stops being true and nothing tells you.
- **No Facets, and no innate-ability specifics.** Both were rewritten in the current patch.
- **Long-standing items only.** 7.41 added nine items this author cannot describe accurately.
  Notes name BKB, Blink, Pipe, Glimmer and their peers — items that have meant the same thing for
  years.
- **One speakable line per note.** Riki says these out loud. A note that has to be summarised
  before it can be spoken is the wrong shape, and the 120-token result ceiling (§4) enforces it
  anyway.

The policy is what makes "static, never refreshed" survivable rather than reckless. A library of
shape decays over a year; a library of numbers is wrong the week after a patch.

## 4. The command

One command, `search_hero_library`, in the `reference` effect class:

```text
search_hero_library(hero, topic?)
```

- **`hero`** is required and is a `hero` subject, so it goes through the existing alias and fuzzy
  resolver — and, more importantly, through the draft check. A hero not in this match resolves to
  `unknown_subject`, which is correct: at advice time the only heroes worth notes are the ten on
  the map, and letting the agent browse the library for absent heroes invites exactly the
  untethered speculation §4.3 of the command architecture exists to prevent.
- **`topic`** is an optional enum: `overview` · `laning` · `timings` · `items` · `weaknesses` ·
  `counters`. Six values, closed, and the manifest's only enum.

**There is no `query` argument, and a later command here should not add one either.** A free-text
field that ranked notes within the chosen hero was built first and removed. It lost on its own
merits: over six one-line notes, term overlap beat `topic` at nothing, any query that missed
degraded to priority order — which is now the only order — and it cost 33 tokens of permanent
manifest space for the privilege.

The reason to keep it out outlives that measurement. A free-text argument is a channel carrying
whatever the model decided to type on the day: match state, the player's name, a chat line it just
read. Against a local reader that costs nothing, because the value goes into a `filter` and stops.
But `ReferenceDataPort` is the seam a networked implementation would arrive behind (§6), and on the
day one does, the same argument becomes an egress question — and *"what exactly leaves this
machine?"*, which `dota2-state-capture-design.md` §7 asks be answered by enumeration, stops being
answerable by construction. `hero` resolves through a table we control and `topic` is a six-value
enum, so today the answer is a set small enough to print. That is cheap to keep and expensive to
recover.

The manifest is where this can actually regress, because the JSON Schema is what the model is shown
and fills in from — so `manifest.test.ts` asserts the schema offers exactly `hero` and `topic`.

Budgets come from the effect class unchanged: 400 ms deadline, 120 result tokens, four calls per
turn, `patch` cache. The 120-token ceiling is the reason notes are one line each — a paragraph
would be truncated mid-sentence, and the composer would have to choose which half to keep.

**A hero in the match but not in the library** answers `unavailable`, in Riki's voice, and is
distinct from `unknown_subject`. Given a 20-hero library and a 10-hero match, this is the common
case, not the edge case, and it has to sound like a coach saying "nothing special on that one"
rather than like a broken tool.

**The patch tag is not droppable.** Every result carries `patch 7.41e`. The snapshot's rule —
never render a stale fact as a bare fact — applies to library notes as much as to a CV sighting,
and the tag is the only thing standing between "notes written for 7.41e" and "the truth". It
survives truncation by construction, which costs about four tokens.

## 5. How this ages, and what happens then

It gets worse, slowly, and nothing in the system will tell you. That is the accepted cost of the
no-refresh decision (ADR-0023), so the mitigations are all up front:

1. Content is shape, not numbers (§3), so it degrades gracefully rather than becoming false.
2. Every result is stamped with the patch it was written for (§4), so the model can hedge.
3. The roster and the rule that produced it are in §2, so re-running the selection is an
   afternoon's work rather than an archaeology project.
4. The port seam (§6) means a live implementation can replace the static one without touching the
   command, the renderer or the tests.

The signal that it is time is a patch that changes hero *kits*, not one that changes numbers.

## 6. Where it lives

`packages/context/src/reference/hero-library/` — content grouped by position, one file per role,
plus a pure search function over it. Above it, `ReferenceDataPort` gains one method:

```ts
heroLibrary(query: HeroLibraryQuery): Promise<ToolOutcome<HeroLibraryResult>>;
```

The port takes the *query*, not the hero, and returns ranked notes. That is the load-bearing
choice: it puts the search behind the seam, so a later remote implementation can rank server-side
instead of shipping a hero's whole entry to be filtered locally. A handler may touch nothing but
its ports (§5 of the command architecture), so this is also the only shape that lets the handler
reach the library at all.

The static implementation is `createStaticHeroLibrary()`, which the composition root wires into
whatever it builds `ReferenceDataPort` from. It is pure, synchronous underneath, and cannot fail —
which makes it the first real implementation of any part of that port, all of which has been fake
until now.

**Why not a `packages/reference` of its own.** That was proposed while a live implementation was on
the table, on the grounds that `packages/context` must be able to run its whole suite with no
network, no filesystem and no key — and an HTTP client plus a disk cache would end that. Neither is
here. This is a data table and a `sort`, which is what the rest of this package already is. The
purity property holds, and `eslint.config.js` still forbids `fs`, `path` and `http` in this package,
which is the ban that would fire if it ever stopped being true.
[ADR-0023](../adr/0023-the-hero-library-is-static.md) records the reasoning.

The moment any of this content is fetched rather than authored, that argument comes back and the
implementation moves to a package of its own. The port interface is already the seam that makes that
a move rather than a rewrite, which is the whole reason it is a port.

**The alias table is deliberately untouched, and this has a measured limit.** Nine of the twenty
heroes have no entry in `tools/aliases.ts` — Spectre, Juggernaut, Invoker, Lina, Dawnbreaker, Bane,
Undying, Snapfire and Enigma. They resolve by **canonical name only**. The fuzzy fallback does not
cover the gap the way it appears to: `distance()` returns early once the length difference exceeds
two, so it forgives typos and not abbreviations, and `eni` does not reach Enigma. That is pinned by
a test rather than left to be rediscovered.

The trade is accepted because the argument is written by the model, not spoken by the player, and a
model that has just been shown `Enigma` in a snapshot writes `enigma`. Feeding the table on a guess
about what it will say instead would be exactly the maintenance that file's own documentation says
to drive from the fuzzy-match rate.

## 7. What v1 does not do

- No refresh, no scheduler, no fetch at runtime (the point of ADR-0023).
- No cross-hero search: every query is keyed to one hero. A "which of these five is the threat"
  question is the agent's synthesis job across several calls, not a query language here.
- No matchup pairs. `get_matchup_advice` already owns hero-versus-hero and takes the player's own
  hero from the model so the sides cannot be swapped; duplicating that here would give the agent
  two ways to ask one question and one of them would be wrong.
- No item builds. Naming a 7.41 item order is exactly the numbers-not-shape mistake §3 forbids.
- No draft or ban advice. The library is keyed on heroes in the match, which is the wrong shape
  for a draft, and Riki does not currently speak during one.

## See also

`agent-command-execution-architecture.md` §5.3 (reference data), §4.3 (subject resolution), §8.1
(the manifest tax) · `dota2-state-capture-design.md` §2.4 (external data is best-effort) ·
ADR-0023 (why static).

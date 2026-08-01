# The hero library

A small, static body of coaching knowledge about the heroes that matter most on the current
patch, which the coaching brief pulls from at advice time.

**Assumptions this document makes.** The reader knows the three context tiers
(`context-and-memory-architecture.md`) and the coaching path
(`coaching-architecture.md` — the library is one brief section and nothing else).
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
| Integration | **Not** pre-baked into prompts or config | One brief section, on five `BRIEF_PLAN` rows (§4). Nothing when no covered hero is drafted |

The fourth answer is the one that shapes the code. A library baked into the session preamble
would be paid for on every turn of every match, in the cached prefix, whether or not any of it was
relevant, and it is twenty heroes of notes to serve the ten in the game. As a brief section it costs
**one line, only on the turns whose plan row asks for it, and only when the draft contains a hero it
covers** — which in the golden corpus's fixed world is no turns at all, because none of those five
enemies is one of the twenty. That is the section working, not a gap.

## 1. What this is for

Riki's world model knows what is happening. It does not know what *usually* happens: that Spectre
is weak before her second item and inevitable after it, that Treant's lane presence is the reason
he is contested, that you do not fight Enigma without knowing where Blink is. That knowledge is
patch-flavoured but not patch-derived, it is the same in every match, and it is exactly what a
coach says out loud.

So it is reference data — *the data that is not about this match* — and it does not go into the
world model. The world model holds what was observed, with an age and a confidence on every fact;
this holds what is true in every game and was never seen at all.

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

## 4. How the brief reaches it

The library is not a thing the agent asks for. Riki's coaching path is **proactive**: `packages/events`
decides a moment is worth speaking about, and `packages/context/src/coaching/` decides what the model
is shown for it ([ADR-0023](../adr/0023-coaching-replaces-command-execution.md)). So the library is a
**brief section**, `library`, and the extension point is one row per event id in `BRIEF_PLAN`.

```text
library: Enigma — Never group up without knowing where Enigma is. That is the whole of the
counterplay. | Lina — Magic resistance and BKB blunt her almost entirely. | 7.41e
```

**Which heroes.** The enemies in this draft that the library covers, most threatening first, capped
at two. The ordering is *read* from `derived.threats` — the world model's own answer to "who can
reach the player" — and never computed here, because comparing two positions is arithmetic over
observed values, which `sections/util.ts` puts in `packages/world-model` for the good reason that a
number produced here would have no age and no confidence sitting beside numbers that have both. With
no `derived.threats` yet, it falls back to roster order: arbitrary, deterministic, and better than a
section that goes quiet early in a match, which is exactly when hero knowledge is all anyone has.

**Which note.** One per hero, the `counters` topic, highest priority first. Two heroes at a line
apiece is what a coach would actually say out loud, and it is what a ~150-token brief can hold.

**Which rows.** `enemy_missing`, `low_hp_no_escape`, `enemy_core_dead_window`, `player_question` and
`system`. Never first in any of them: position is priority in `BRIEF_PLAN` and the first section is
undroppable, so leading with `library` would let static notes survive a budget that had already
dropped the observed fact the turn fired on — advice about a hero in place of the reason for
mentioning them. It sits above `history` and below everything observed, which is the order a coach
uses: what is happening, then what that hero usually does, then what we already said about it.

**A hero the library does not cover contributes nothing, and does not say so.** With twenty covered
and ten drafted this is the common case rather than the edge, and a brief is not a conversation —
there is nobody to apologise to. `build()` returns `null`, and `render.ts` records that in `omitted`
ahead of the sections the budget took, so the golden corpus shows which of the two happened.

**There is no free-text input, and a later change here should not add one.** A ranking pass over
free text was built first and removed: across six one-line notes it beat `topic` at nothing, and any
query that missed degraded to priority order, which is what the search now does in one step. Under
the proactive model the point is sharper than it was — nothing outside this package chooses what the
library is asked, because nothing outside it asks. `searchHeroLibrary` takes a `HeroId` and an
optional six-value `topic`, and that is the whole surface.

**The patch tag rides inside the section**, not beside it, so it cannot outlive the notes it
qualifies or survive without them. Nothing refreshes this content, so the tag is the whole difference
between "written for 7.41e" and a claim about the game as it is now — the snapshot's rule against
rendering a stale fact as a bare fact, applied to the axis that actually moves in Dota. It costs
about four tokens.

## 5. How this ages, and what happens then

It gets worse, slowly, and nothing in the system will tell you. That is the accepted cost of the
no-refresh decision ([ADR-0027](../adr/0027-the-hero-library-is-static.md)), so the mitigations are all up front:

1. Content is shape, not numbers (§3), so it degrades gracefully rather than becoming false.
2. Every result is stamped with the patch it was written for (§4), so the model can hedge.
3. The roster and the rule that produced it are in §2, so re-running the selection is an
   afternoon's work rather than an archaeology project.
4. The port seam (§6) means a live implementation can replace the static one without touching the
   section, and a live one would replace the function behind it.

The signal that it is time is a patch that changes hero *kits*, not one that changes numbers.

## 6. Where it lives

`packages/context/src/reference/hero-library/` — content grouped by position, one file per role, plus
a pure search over it. `packages/context/src/coaching/sections/library.ts` is the section that reads
it, and it is the only thing that does.

The library exports a function, not a port. That is the shape the current architecture wants and it
is worth being explicit about why, because an earlier draft of this design had it behind
`ReferenceDataPort` with an async method returning a result-or-failure. `coaching/contracts.ts` is
direct on the point: **the brief must not be able to make a turn slow**, and the reason the deleted
command pipeline needed a watchdog, a breaker and a queue was that a command could reach a network. A
frozen array and a `filter` earn none of that. Wrapping them in a promise would have advertised a
failure mode that does not exist and invited someone to add one.

**Why not a `packages/reference` of its own.** Proposed while a live implementation was on the table,
on the grounds that `packages/context` must run its whole suite with no network, no filesystem and no
key, and an HTTP client plus a disk cache would end that. Neither is here. `eslint.config.js` still
forbids `fs`, `path` and `http` in this package, and that ban is what would fire if it ever stopped
being true. The day any of this content is fetched rather than authored, the argument comes back and
the move is a package boundary, not a rewrite.

## 7. What v1 does not do

- No refresh, no scheduler, no fetch at runtime (the point of ADR-0027).
- No cross-hero search: every query is keyed to one hero. A "which of these five is the threat"
  question is the agent's synthesis job across several calls, not a query language here.
- No matchup pairs. `get_matchup_advice` already owns hero-versus-hero and takes the player's own
  hero from the model so the sides cannot be swapped; duplicating that here would give the agent
  two ways to ask one question and one of them would be wrong.
- No item builds. Naming a 7.41 item order is exactly the numbers-not-shape mistake §3 forbids.
- No draft or ban advice. The library is keyed on heroes in the match, which is the wrong shape
  for a draft, and Riki does not currently speak during one.

## See also

`coaching-architecture.md` §4.4 (`BRIEF_PLAN` and the section vocabulary), §5.4 (the sections),
§6.5 (a brief that renders nothing) · `dota2-state-capture-design.md` §2.4 (external data is
best-effort), §7 (egress) · [ADR-0027](../adr/0027-the-hero-library-is-static.md) (why static) ·
[`web-search-providers.md`](../research/web-search-providers.md) (why not live).

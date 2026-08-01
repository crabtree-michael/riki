# ADR-0013: Durable player memory is a closed union of typed observations, stored locally

**Status:** Accepted, with one question for a human (see Consequences)
**Date:** 2026-08-01

## Context

`dota2-state-capture-design.md` §6.1 puts "hero comfort/history" in the session preamble and §2.4
sources it from OpenDota. That is the player's public match history: coarse, available to anyone,
and identical whether or not Riki has ever spoken to them.

What Riki can know and a stats site cannot is how *this* player responds to *this* coach — that they
act on ward advice and ignore rune reminders, that they die to the same rotation in three matches
out of four. That is three lines in the preamble and it is most of the difference between a coach
and a dashboard. It requires remembering something across matches, which nothing in Riki currently
does.

It also means Riki writes a file about a person, which is the first persistence surface in the
product that is about the player rather than about the game.
`dota2-state-capture-design.md` §7 has already set the standards this has to meet: nothing about
other players, no raw capture, privacy-relevant defaults off, and a first-run flow that enumerates
per source what is captured and where it goes.

## Decision

Durable memory is a **closed union of typed observations with no free-text field anywhere in it**:

```ts
export type PlayerObservation =
  | { kind: 'hero_played';      hero: HeroId; role: Role; result: 'win'|'loss'|'unknown'; at: number }
  | { kind: 'advice_response';  topic: AdviceTopic; response: AdviceResponse; at: number }
  | { kind: 'pattern';          pattern: PatternId; at: number }
  | { kind: 'preference';       key: PreferenceKey; value: string };
```

Every `string` in it is an id or an enum. Chat lines, voice transcripts, player names and model
output are **not representable**, so they cannot be written by mistake — the guarantee is the type,
not a rule someone has to remember.

It is keyed by the local player and by nothing else; there is no key for a teammate or an opponent.
Other people appear only as hero ids, which are not people. It is stored on the local disk through a
four-method key/value port (`MemoryStore`) at a path `packages/config` resolves, so
`packages/context` performs no I/O and names no path. It is versioned, and a version mismatch or a
parse failure yields an **empty** memory plus a telemetry line — never an error, and never a guessed
migration. It is on by default, disabled by `RIKI_MEMORY=off`, and erased by one `forget()` call
behind one settings button.

Nothing in Riki is load-bearing on it. An empty memory is a fully working coach.

## Consequences

- The preamble gains a `history` section that is about coaching rather than about win rate, which is
  the reason to do this at all.
- The privacy guarantee is checkable in a Tier 1 test that costs almost nothing, because it is
  structural: feed a ledger full of chat through the projection and assert the resulting
  `PlayerMemory` contains none of it. Adding an observation kind with a free-text field fails it.
- Discarding on a version mismatch means a schema change costs the player their history. That is
  accepted: the alternative is a migration that can be subtly wrong, and being wrong about what
  someone did in past games is worse than not knowing.
- The aggregate reaches OpenAI, because it is rendered into the preamble. It is hero names and
  counts, which is the ✅ row of dota2 §7's egress table — but it is still egress, and the first-run
  flow has to say so.
- **The open question this leaves for a human:** this design has the feature **on by default**, on
  the grounds that the closed union makes it structurally incapable of holding what dota2 §7
  protects. REPO_SKELETON §7.2's rule is that privacy-relevant defaults are off. Both readings are
  defensible, and "Riki writes a file about how you play" is the kind of thing a person should be
  told once even if the file is harmless. Recorded as open question 12 and as §15.2 of the design
  doc; the first-run consent flow is where it gets settled.

## Alternatives rejected

- **A free-form notes blob, or "let the model write what it wants to remember".** The most flexible
  option and the one that makes every privacy guarantee unenforceable: model output is free text,
  free text can contain anything it saw, and what it saw includes other players' chat. There would
  be nothing left to test.
- **Store the conversation ledger across matches instead.** It already holds everything, which is
  exactly the problem — it holds the player's voice transcript. Persisting it is a separate,
  opt-in debug flag (ADR-0012).
- **Only use OpenDota, and remember nothing.** No persistence surface, no privacy question, and no
  coaching memory. It also makes Riki interchangeable with a stats overlay, which is not the product.
- **Remember other players** — "this Pudge ganks at level six" across matches. Genuinely useful,
  and rejected: it is a dossier on people who did not consent to one, and dota2 §7's whole posture
  is that other players' data is not ours to keep.
- **Migrate on schema change rather than discard.** A migration that is wrong produces confidently
  false claims about the player's own history, which is the same failure class dota2 §4 rule 3 calls
  the worst outcome the product has, applied to a different subject.

See [context-and-memory-architecture.md](../design/context-and-memory-architecture.md) §6.4 and §6.5.

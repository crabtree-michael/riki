# ADR-0043: An unknown is a shape, not a null

**Status:** Accepted
**Date:** 2026-08-09

Implements the tool surface of [ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md)
and [conversational-architecture.md](../design/conversational-architecture.md) §4–§5. Completes the
migration [ADR-0018](0018-argument-schemas-from-a-local-declaration.md) asked for and never got.

## Context

ADR-0042 gives the model five tools and one obligation: *"every returned value is a `Fact` — value,
age, confidence, source — or an explicit `unknown`… the tool layer's whole correctness obligation is
to not flatten it on the way out."*

That obligation has an obvious encoding and the obvious one is wrong. `{ value: number | null }`
reads as the natural way to say "we might not know this", and it fails twice: `null` carries no
reason, so a model that receives it can only guess whether nobody looked or nobody was there; and a
caller that forgets the null check reads an absence as a value, which is the exact failure
`packages/world-model/src/fact.ts` opens by naming — a pipeline that flattens a 0.55-confidence
minimap blob and a GSI health value into the same `number` has discarded the only thing that stops
Riki confidently getting someone killed.

The stakes are higher on this side of the boundary than inside the world model, for a reason
specific to what changed in ADR-0042. Riki used to speak from a brief that something else had
assembled and checked. It now speaks from whatever a tool hands it, mid-sentence, out loud, with no
stage in between.

Two smaller questions came with it. `packages/protocol` had never held a boundary whose other side
was not another build of Riki. And ADR-0018 declared its own replacement — *"when
`packages/protocol` lands zod and a JSON-Schema emitter, `defineArgs` should be reimplemented on top
of them"* — for a tool surface that then got deleted before the swap happened.

## Decision

**A tool value is a union of two strict shapes: `{ value, age_seconds, confidence, source }` or
`{ unknown: reason }`.** There is no field to forget. The unknown branch has no `value` for
TypeScript to let anyone read, both branches reject unrecognised keys so an object carrying a value
*and* an unknown parses as neither, and `isUnknown` is the only way through. There is deliberately
no `valueOr(fact, fallback)` and no accessor returning `T | undefined`: a fallback is a made-up
number wearing a real number's type.

The surface lives in `packages/protocol/src/schemas/tools.ts` as zod, and the JSON Schema the model
is shown is generated from those same schemas at run time by `packages/realtime/src/tools.ts` —
which is ADR-0018's migration, arriving with the tools that need it.

## Consequences

**A flattened fact fails at the encoder rather than at the player.** `encodeToolOutput` validates
every answer against its schema before it becomes a `function_call_output`, so a tool that answered
a never-observed field with a plausible zero is a test failure, not a sentence. That is the last
point where it *can* fail: past it, a zero from a guess and a zero from GSI are the same four bytes.

**Every field of every tool can be unknown, and the corpus proves it per field.** The contract test
walks the fixtures, finds each fact-shaped leaf, and asserts at each one that it may be `unknown`
and may not be a bare value. A tool that grows a field gets both assertions the moment a fixture
covers it.

**This boundary carries no version, and that is a real asymmetry with the other two.** Every message
in `schemas/sidecar.ts` and `schemas/voice.ts` carries `v` because the peer may be a different
build. The peer here is a language model: it has no build, and a version it sent would be one it
invented. What replaces the check is that the model is shown the argument schema in the same
`session.update` that opens the session — so a mismatch is impossible for the length of a session
and meaningless outside one.

**It generates no Rust, and `MODULES` in `scripts/codegen.mjs` stays a one-entry list.** Adding a
schema file does not wire it into codegen. That is the same call `schemas/voice.ts` made and it is
right for the same reason, but it now applies to two of the package's three surfaces, which makes
"protocol means generated" a wrong summary of this package rather than a rough one.

**snake_case, in a camelCase package.** The field names are read by a model, appear as snake_case in
the design document, and match the tool names themselves. Consistency with the reader beats
consistency with the file next door, and the cost is that this package no longer has one convention.

**Counts are `mine`/`theirs`, never `radiant`/`dire`.** The model would otherwise have to remember
which side the player is on to read a scoreboard, and "you're up four towers" is a complete and
confident sentence whichever way round it is. `my_state.team` carries the actual side, as a fact
like everything else, for when it matters.

**The declared surface is wider than what `packages/world-model` can currently answer.** `lanes` in
`economy` needs the scoreboard; `recently_lost` needs building history nothing keeps yet. They are
declared anyway, because the honest answer to a question we cannot answer is an `unknown` with a
reason — and a field that had to be inferred from the *absence* of a field would not be that. The
risk this accepts is a manifest advertising more than it delivers, which ADR-0011 also accepted and
for the same reason: availability belongs in the result, never in the presence of the tool.

## Alternatives rejected

**`{ value: T | null }`, or an optional field.** The encoding this ADR exists to refuse. Both
reasons are above; the second one — a caller reading an absence as a value — is not hypothetical,
it is what a `Fact` is for.

**A `status: 'known' | 'unknown'` discriminator.** Honest, explicit, and a field on every leaf of
every answer for the length of a match. The two shapes are already distinguishable by their keys, so
the tag is tokens spent to restate what is there.

**An enum of unknown reasons.** Testable, cheap, and turned back into a sentence somewhere else
anyway — the reason is read aloud. `UNKNOWN_REASONS` is a suggested vocabulary instead, so five
tools written by different hands do not give the player five phrasings for one condition, without
making a sixth phrasing impossible.

**Put the tool types in `packages/world-model` and let `packages/realtime` import them.** Fewer
files, and it inverts ADR-0014's seam: the world model would then know it is feeding a language
model. The lint boundary that forbids `world-model → realtime` exists for that reason, and the
shared vocabulary between two packages that may not import each other is what `packages/protocol`
is.

**Hand-write the `parameters` JSON Schema beside the zod validator.** ADR-0018 §"Alternatives" named
this as the failure the arrangement prevents, `pnpm codegen` exists to prevent the same one for the
sidecar, and here it presents as the model being told a shape, sending it, and being told it is
invalid — during a spoken answer, where a failed call is not a retry but a pause.

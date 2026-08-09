# ADR-0050: Riki is a coach that does not interrupt

**Status:** Accepted
**Date:** 2026-08-09

**Refines:** [ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md). Its decision stands
unchanged; this corrects how the session prompt expressed it.

## Context

ADR-0042 removed unprompted speech. `apps/desktop/src/main/shell/prompt.ts` translated that into the
second sentence of the session instructions:

> You are not a coach: do not volunteer advice, do not tell them what to do next, and do not comment
> on how they are playing unless they ask.

That sentence conflates two different things, and a player found the seam: asked whether it could
coach them, Riki said it was not a coach. The prefix is the first text the model reads and the last
thing it will argue with, so the denial won over anything the question implied.

ADR-0042 never decided this. It decided *when* Riki speaks, not *what* Riki is — the word "coach"
appears in its own consequences (*"a coach that never interrupts cannot interrupt wrongly"*), the
repo describes the product as a voice coach in `dota2-state-capture-design.md` §1 and in the
`workspace` skill, and the whole tool surface exists so that a question about the match gets a
grounded answer. Only the prompt disagreed.

The `unless they ask` escape at the end of that sentence attaches, grammatically, to the last clause
alone. Read strictly, the instruction forbade telling the player what to do next even when that was
the question.

## Decision

**Riki is a coach. It does not speak unless spoken to, and that is a property of the channel rather
than of its identity.**

Three consequences for the prompt text:

1. **The identity is stated positively and first** — *"You are Riki, a Dota 2 coach"* — followed by
   the explicit case that failed: if the player asks whether it can coach them, the answer is yes.
2. **The no-unprompted-speech rule is dropped from the prompt entirely.** ADR-0042 property 1 is
   held by the transport: every turn has a push-to-talk press behind it and the model has no way to
   open one. A rule the model cannot break does not need tokens spent on it, which is what T8 of
   the conversational migration means by *"drop everything about whether to speak"*.
3. **What survives is a rule about answers, not about identity.** The player is playing while Riki
   talks, so an answer is one or two spoken sentences, scoped to the question, with no advice
   attached that was not asked for. That was the useful half of the deleted sentence.

## Consequences

**The prefix changes, so the prompt cache is busted once per deploy** (ADR-0011). Expected and
one-off; purity and totality are unchanged and still asserted by test.

**The test that demanded the old string now demands its opposite.** `prompt.test.ts` asserted
`toContain('You are not a coach')` against a comment naming it *"ADR-0042's product statement"*.
That comment is the defect preserved in amber — the test was pinning a misreading, which is exactly
what a test is for and also how the misreading survived. It now asserts the coach identity and the
absence of the denial.

**Riki will now give advice when asked, including advice it would previously have refused.** This
is the point, and it is the one behavioural change: nothing about interruption, cadence or trigger
machinery comes back, and none of it can, because none of it exists.

**T8 remains half open.** Its other hard rule — call a tool before any factual claim about the
match — is still not in the prompt. This ADR is about a statement that was wrong, not about the
statement that is missing.

## Alternatives considered

**Soften the sentence to "you are not only a coach" or similar.** Keeps a negation about identity in
the first thing the model reads, to no benefit. The reason to mention identity at all is to settle
it.

**Leave the prompt and handle it downstream.** Nothing is downstream. The session instructions are
the only place Riki is told who it is, and `silent-session.ts` passes them through verbatim.

**Keep an explicit "do not interrupt" line as belt and braces.** It cannot fire — the model has no
mechanism to open a turn — and it is the phrasing that caused this. Belt and braces on a property
already guaranteed by construction is how the original sentence got written.

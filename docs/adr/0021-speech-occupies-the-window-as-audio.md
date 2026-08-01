# ADR-0021: An utterance occupies the context window as audio, not as its transcript

**Status:** Accepted
**Date:** 2026-08-01

## Context

[`context-and-memory-architecture.md`](../design/context-and-memory-architecture.md) §7 rests
entirely on one number: our estimate of how many tokens the model's context window currently holds.
The low-water mark, the "keep the last six turns" guarantee, the elision base and the decision to
compact at a quiet moment are all computed from it. §7.6 already names the risk — *what we believe
versus what is true* — and §12's second row lists the estimate as unverified.

Implementing `WorkingMemory.window()` forced a question the design leaves implicit: **what does one
`agent_said` entry cost?**

The obvious answer is to run its transcript through the injected `TokenCounter`, which is what every
other entry does. It is also wrong by roughly an order of magnitude.
[`openai-realtime-research.md`](../research/openai-realtime-research.md) §5 prices assistant audio at
~1,200 tokens/minute and user audio at ~600 — the conversation is *audio*, and the transcript is a
side artifact of it. Ten seconds of Riki talking is ~200 tokens in the window and about 25 tokens of
text.

A ledger that costed speech by its text would therefore believe the window far emptier than it is.
Compaction would fire late or not at all, and the first correction would come from the API
truncating oldest-first — which removes the **cached prefix**, so Riki forgets its persona and the
whole match preamble and keeps its most recent small talk (§7.3). That is precisely the failure the
whole of §7 exists to reach first.

## Decision

`entryTokens()` costs `agent_said` and `player_said` from a **spoken word rate**, not from the
transcript's token count:

```ts
speechTokens(text) = max(counter.count(text), words(text) * TOKENS_PER_SPOKEN_WORD)
```

`TOKENS_PER_SPOKEN_WORD` is **8**, derived as ~1,200 tokens/min ÷ ~150 spoken words/min. The text
count is a floor, never the answer.

Two smaller consequences of the same reasoning:

- **A function call costs more than its rendered result.** A `command` entry is costed as
  `result.tokens + CALL_OVERHEAD_TOKENS (12) + tokens(name)`, because the model sees a
  `function_call` item as well as its output.
- **`turn_opened` and `turn_closed` cost nothing and are never `inWindow`.** They are Riki's own
  bookkeeping and are never sent to the model; counting them would manufacture drift that has
  nothing to do with the API.

The direction of the error is deliberate and matches §3.2's rule one level up: **a counter that
estimates must over-count.** Over-counting compacts a little early, which costs a cache bust we
chose. Under-counting compacts too late, which costs the cached prefix at a moment nobody chose.
Only one of those is recoverable.

## Consequences

- §7.1's per-minute arithmetic is reproducible in code rather than only in prose, and the numbers
  the retention policy acts on are the ones the design sized itself against.
- **A single per-speaker constant is used for both sides.** realtime §5 prices user audio at half
  the assistant rate, so the player's speech is over-counted by roughly 2×. That is a few tokens a
  turn, and a second constant would be a second thing to keep calibrated for no decision it would
  change.
- **The constant is an estimate and is now load-bearing.** It joins §12's first two rows as
  something to measure rather than believe: token-count a replayed match's turns against
  `rate_limits.updated` and compare. If the real rate is materially different, this is the one
  number to change, and it is in one file (`memory/occupancy.ts`).
- A transcript that is empty — a turn where the model spoke but the transcription failed — costs
  zero, and the window estimate under-reports for that turn. Accepted: the alternative is guessing a
  duration we do not have, and `ContextWindowPort.usage()` is the reconciliation path §7.6 already
  provides for exactly this class of drift.

## Alternatives rejected

- **Cost speech by its transcript.** Simple, consistent with every other entry, and wrong in the
  direction that loses the cached prefix.
- **Carry an audio duration on the ledger entry.** More accurate, and it would be the right answer
  if we had the number — but `LedgerEntry` is the closed contract in §3.3, the duration is
  `packages/realtime`'s to know, and adding a field would make this component depend on a session
  detail to compute a policy it is meant to compute from a fixture. If §12's measurement says the
  word-rate estimate is not good enough, the correction belongs in `ContextWindowPort.usage()`,
  which already exists for it.

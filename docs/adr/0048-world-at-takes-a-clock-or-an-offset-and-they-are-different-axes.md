# ADR-0048: `world_at` takes a clock or an offset, and they are different axes

**Status:** Accepted
**Date:** 2026-08-09

## Context

[conversational-architecture.md](../design/conversational-architecture.md) §11 leaves open question
2 for whoever built the timeline reader: *should `world_at` accept a wall-clock offset ("thirty
seconds ago") as well as a game clock? Players speak in both.* T2 shipped the argument schema with
`clock` only and recorded the question as T6's to settle.

Without an offset, "where was he just now?" — which is the commonest phrasing in the product, and
the one asked in the middle of a fight — costs the model an `objectives()` call to learn the current
clock, then subtraction in base sixty, then the `world_at` call. Two round trips inside a spoken
sentence is the latency risk §10 already names, and the arithmetic is the part that actually worries
me: a model that computes 12:15 − 0:30 as 11:45 produces a confident, fluent, checkable-sounding
answer about the wrong minute. Nothing downstream can tell that from a right one.

There is a second, quieter problem with making the model do the conversion. During a pause the game
clock is frozen, so thirty seconds of a player's life is zero seconds of match clock — and before
the horn there is no clock at all, so a question about the draft cannot be phrased on that axis by
anyone.

## Decision

`world_at` takes **`clock` or `seconds_ago`, exactly one**, and the two resolve on **different
axes**: `clock` seeks on match time, `seconds_ago` seeks on wall time, measured back from the last
line the recording holds. Neither is converted into the other. The answer's `at_clock` reports the
match clock of the moment actually reconstructed, so whichever way the question was asked, the model
speaks a number the player can check.

`seconds_ago` is a number of seconds. Free text is not accepted and is not on the table: a phrase
the validator refuses is a tool call that fails out loud, mid-sentence.

## Consequences

Two axes is more surface than one, and the honest cost is that a caller has to know which is which.
The payoff is that neither is ever quietly wrong: a pause is exactly when the two diverge and
exactly when somebody is asking, and the draft is answerable on the wall axis and not answerable at
all on the other one.

`clock` is now optional, which is the part that had to be paid for elsewhere:

- **The shape is one object with a refinement, not the union T2 predicted.** `z.union` of two strict
  objects emits `anyOf` at the *root* of `parameters`, which carries no top-level
  `additionalProperties` — so `assertRealtimeToolShape` throws on the manifest, and OpenAI's strict
  function schema wants a root object regardless. Measured, not assumed.
- **`z.toJSONSchema` cannot express the refinement.** The model is shown two optional fields and is
  told the exactly-one rule in the field descriptions. `parseToolCall` still enforces it and its
  message is the correction handed back, so a hedged call costs a retry rather than a wrong answer —
  but the schema is no longer the whole contract, which it was before. A test asserts the prose is
  still there, because the prose is now load-bearing.
- `required: ['clock']` is gone from the manifest. `packages/realtime`'s test that asserted it now
  asserts what replaced it.

This is a `packages/protocol` change and therefore a coordination event. It is additive for every
existing caller: `{ clock: "12:34" }` parses exactly as before.

## A second decision, forced while building it: the replay bound is the history window

[conversational-architecture.md](../design/conversational-architecture.md) §6 says a `world_at`
query replays "never more than 30 seconds … regardless of match length", and the timeline reader
reads back further than that on purpose.

A keyframe does not carry the two ring histories, which
[ADR-0044](0044-a-match-recording-is-a-fixture.md) decided and which is right — the delta tape *is*
the recording. But `objectives.recently_lost` is recovered from the delta ring rather than read
from a field (T3's `tools/buildings.ts`, which found that the ring makes the field answerable at
all, against T2's expectation), it looks back `DEFAULT_HISTORY_WINDOW_SECONDS`, and it is a bare
array inside `BuildingsReport` with no `unknown` branch. A reconstruction that replayed thirty
seconds would therefore hand the model an empty array meaning *"nothing has fallen"* — out loud,
every time, about a match in which two towers had. That is ADR-0043's failure reached from the
other side, and it was caught by asserting a historical answer against the live tools rather than
against a hand-written expectation.

So the anchor is the newest keyframe at or before `t − historyWindowSeconds`, and the replay
rebuilds the ring as it goes with the same two lines `WorldModelStore.commit` runs. The bound
becomes `historyWindow + keyframeInterval` — 5½ minutes, ~2,600 `fuse` calls at 8 Hz, a few
milliseconds. **The property §6 was protecting is intact**: the cost is a constant and is flat in
match length, so minute two and minute thirty-nine cost the same. Only the constant is bigger, and
a test asserts both the ceiling and the flatness so that the next person to change the history
window sees what it costs.

The alternative — replay one interval and populate the ring with whatever that covers — is worse
than either option, because it answers with a *subset* presented as the whole and there is nothing
in the shape to say which.

## Alternatives rejected

**Clock only; let the model subtract.** The status quo, and the reason for this ADR. It puts
sexagesimal arithmetic on the critical path of a spoken answer and turns a slip into a confident
answer about the wrong moment. It also needs a preceding `objectives()` call the model has no
incentive to make.

**Accept "thirty seconds ago" as free text and parse it.** T2 named this as the thing that is *not*
additive, and it is right. A phrase the parser does not recognise is a rejected call in the middle
of a sentence, and a phrase it recognises *wrongly* is worse.

**One field, `at`, accepting either grammar.** `-1:30` already means "ninety seconds before the
horn", so a bare `30` would have to mean "thirty seconds ago" — two meanings for one field,
distinguished by punctuation. Whatever the model got wrong there would be invisible.

**Convert `seconds_ago` to a clock and seek once.** Simpler, and wrong for the two cases the second
axis exists to serve: during a pause it answers about the wrong moment, and during the draft it
cannot answer at all.

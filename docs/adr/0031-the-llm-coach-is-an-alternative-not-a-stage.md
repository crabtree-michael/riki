# ADR-0031: The LLM coach is an alternative to the gates, not a stage inside them

**Status:** Accepted
**Date:** 2026-08-02

## Context

Riki's coach is fully deterministic. `packages/events` detects conditions over the world model,
scores them, and runs thirteen gates to decide whether to speak; `packages/context`'s `BRIEF_PLAN`
and a template decide what is said. No model forms a judgement anywhere in that path.

That has a ceiling a bigger rule set cannot raise: a detector only notices what somebody wrote a
detector for, and a template only says what somebody wrote a template for. The hero library
(ADR-0027) was written partly so a coach could reason about matchups and timing windows, and
nothing in the deterministic path can consult it as anything other than a canned line.

The obvious design is to keep the ladder and put a model at the end of it — let the gates decide
*whether*, and let a model decide *what*. That was rejected. It inherits every threshold the gates
encode, so the model can only ever speak about moments a salience floor already approved, and the
one thing it is uniquely able to do — notice that a moment nobody scored is the important one — is
exactly what the ladder in front of it removes.

Four things also had to be decided, and the user settled all four: the LLM decides for itself when
to speak; detector events push it and there is no independent polling cadence; pacing is soft rather
than a suppression gate; and the mode switch is a UI control, not an environment variable.

## Decision

**`packages/coach` is a second, independent answer to the same question `packages/events` answers.
The composition root runs exactly one of them.**

1. **No deterministic suppression in the LLM path.** The salience score, the latch, the cooldowns,
   the novelty gate and the intensity signal do not run. What survives is six *mechanical* skips —
   `quiet_mode`, `muted`, `agent_speaking`, `player_speaking`, `in_flight`, `no_world` — of which
   two are the player's own off switches and four are physics. Nothing may be added to that list
   without an ADR, because a seventh reason is a gate wearing a mechanical hat.
2. **Push-only.** The trigger is a detector reporting a condition that was not true at the last
   consultation. There is no timer, no tick and no `Timers` port in the package. A game in which
   nothing new happens makes no requests.
3. **Soft pacing.** A minimum gap between *asks* and a deadline derived from the detectors'
   own `actWithinSeconds` — which is shown to the model and, when an answer is late, used to check
   whether the named condition is still true rather than to cancel anything. The default direction
   is to speak.
4. **The mode switch is the tray's Coach row**, persisted to `settings.json`. There is no
   `RIKI_COACH` environment variable: a variable in a shell profile would silently undo the
   player's choice on every restart, and a UI control something else can override is not a control.
5. **The detector supplies the topic, always.** The model names which of the signals it was shown it
   is speaking about, by key; the coach resolves that key back to the signal it sent and takes
   `kind`, `key` and `topic` off the detector. A judgement naming anything else is discarded, not
   repaired. This is what keeps ADR-0013 intact across a seam with a language model in it.
6. **OpenAI's Agents SDK**, confined to one file, with the API key injected as a structural
   `RevealableKey` and tracing off by default.

The deterministic coach is kept whole and is the default. It is the baseline, it is the only one
tunable against a fixture corpus with no network, and it is what runs when there is no key.

## Consequences

**The tuning instrument changes.** `packages/events` is tuned by reading per-gate refusal counters
against a replay corpus. This coach cannot be: its equivalent is `CoachJudgement.reasoning`, a
sentence recorded on every consultation whether or not it spoke. That is a worse instrument in every
way except the one that matters — it can explain a silence nobody anticipated.

**Two coaches is two things to keep working.** They share the eight detectors and the snapshot
renderer deliberately, so a change to either is felt by both, and everything between those two
points is not shared at all.

**A live model is now on the coaching path.** `openai-model.ts` is not unit tested, because a test
of it could only mock the SDK. Everything else in the package is Tier 1 against `FakeCoachModel`.

**The event tape is empty in `llm` mode**, so the narration's `recent:` line says nothing about what
has been happening. A real gap, recorded as open question 3 in the design document.

**A ninth `CoachEventKind` is now a three-file change** — a detector, `BRIEF_PLAN`, and nothing in
`packages/coach`, which reads whatever the detectors produce. That is the one place this design is
cheaper than the one it sits beside.

## Alternatives rejected

**A model behind the gates.** Rejected above: it inherits every threshold and removes the only
capability that justifies the model.

**Both coaches at once, merged.** Two proposals for one turn slot needs a third policy to arbitrate,
and that policy would be the gates again, deciding for the model.

**A separate build or a launch flag.** The user asked for one build with a runtime switch. It is
also the only shape in which the two can be compared on the same match.

**A polling cadence.** Deferred, deliberately. It is the thing that would let the coach notice a
situation no detector names — the strongest argument for having it at all — but it makes every quiet
game cost money on a timer, and the push-only path had to be shown to work first.

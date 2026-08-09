---
name: agent-context
description: What the LLM sees — `packages/context` (the rolling snapshot renderer, the rendering primitives, the hero reference data) and `apps/desktop/src/main/agent/` (the turn agent and the world-view adapter). Use when changing the snapshot format or its token budget, adding a section, or changing what the model is handed for a turn.
---

# Feeding the agent

The player presses a key, asks a question, and the model is handed the match as text. That is the
whole of this area since [ADR-0042](../../../docs/adr/0042-riki-answers-questions-instead-of-deciding-when-to-speak.md).

**`packages/context` is one renderer.** `createSnapshotRenderer()` is its only runtime surface:
`WorldSnapshot` in, ~250–400 tokens out, pure and synchronous. `apps/desktop/src/main/agent/` is
where it meets a world model and a session.

> **Two whole pull surfaces have been deleted here, and the second is coming back.** ADR-0023
> removed `packages/context/src/tools/` — a parse/admit/queue/execute/render pipeline with a
> manifest in the cached prefix — on the grounds that the trigger engine already knew what a turn
> was about. ADR-0042 then removed the trigger engine, which takes that argument with it:
> [`conversational-architecture.md`](../../../docs/design/conversational-architecture.md) §4 gives
> the model five narrow tools instead, and they are waves 2–3 of the migration. **When you build
> them, read ADR-0023 first** — it is the record of how the first one failed, and its
> failure-code taxonomy and consent gate are the parts not to rebuild.

## What is gone, so you do not go looking

`packages/events` (detectors, salience, thirteen gates, the event tape), `packages/coach` (a second
model deciding whether to interrupt), and three quarters of `packages/context`: Tier 1 preamble
assembly, the coaching brief and `BRIEF_PLAN`, the conversation ledger, coaching memory, the
retention policy and durable player memory. If you find a reference to any of them, it predates
2026-08-09 — fix it.

What survived and where it went:

| Was | Is now |
| --- | --- |
| `ContextAssembler.openTurn` | `main/agent/snapshot.ts`'s `SnapshotSource` |
| The Tier 1 preamble | `main/shell/prompt.ts` — T8 owns rewriting it |
| `packages/context/src/reference/` | unchanged, and reachable at `@riki/context/reference` |

## The snapshot format is an interface

Treat a format change like an API change: it goes through `fixtures/golden/snapshot/`, and the diff
is the review. Rules that hold in the renderer:

- **Never render a stale CV fact as a bare fact.** A 30-second-old position must carry its age and
  confidence, visibly, in the rendered text. Presenting a guess as certainty is the worst outcome
  the product has, and `AgeFormatter` in `render/` is the **only** function that turns an
  `Observed<T>` into words. Do not format an age locally.
- **Below-threshold facts are dropped, not hedged.** Hedging spends tokens to say nothing.
- **Budget is enforced by priority truncation**, not by hoping. `SNAPSHOT_LADDER` is the order, as
  data; what survives a tight budget is a design decision and is committed alongside the text.
- **A section does no arithmetic.** Any comparison — farm against a benchmark, a window against the
  clock — is a `derived.*` field from `packages/world-model`. A number computed in a section has no
  age and no confidence sitting next to numbers that have both.

Adding a section is one file in `snapshot/sections/`, one entry in `ladder.ts`, and one golden diff.
**The ladder entry is the part not to skip:** a section with no declared priority truncates in
whatever order the array happened to be in.

## The world-view adapter, and the gap in it

`main/agent/world-view.ts` maps `packages/world-model`'s field names onto the forty-odd paths this
package's sections invented. Its rule is the whole review: **it renames and reshapes, and computes
nothing the world model could not already answer.**

Five paths are deliberately **unsatisfied**, and the sections reading them are omitted and recorded
rather than guessed at: `self.area`, `enemies.*.area`, `derived.threats`, `derived.paceLevel`,
`derived.paceNetWorth`. The first two need a position-to-map-region table that belongs with the
sidecar, which already speaks in regions; the rest need game arithmetic.

⚠ **The consequence is that a CV-observed enemy position does not reach the model today.** It is in
the world model with full provenance, and the `seen:` line that would render it has no data — only
`unseen >20s`, derived from `unseenFor`, gets through. Before ADR-0042 the trigger engine read
positions straight off the world model, so this gap was invisible; it is now the first thing
`enemy(hero?)` has to close. `apps/desktop/test/vision-turn.test.ts` asserts the absence, so the day
it closes shows up as a failing test.

## Latency

Model → snapshot is budgeted under 5 ms, and the whole path is pure and synchronous — nothing here
can reach a network, which is what keeps a turn from needing a watchdog. Anything expensive belongs
in the world model's derived state, computed once per version.

## Privacy

Everything rendered for the model is subject to three rules and two are invisible from inside this
package: the staleness rules above (dota2 §6.2), the log tailer's privacy tagging (state-capture
§4.2 — chat text is `sensitive`), and the Realtime context budget. Check all three.

`render/privacy.ts` currently has **no caller**: the `recent:` line was the last one, and it went
with the event tape. It is kept, and `SnapshotContext.privacy` still carries the policy, because it
is the second of the two independent gates REPO_SKELETON.md §7.2 requires — the next section that
renders a name or a line of chat must go through it rather than re-deriving the policy beside it.

## Learnings

**2026-08-09 — the push-to-talk chain was never joined, and every layer passed its own tests.**
`beginPlayerTurn`/`endPlayerTurn` existed, `main/voice/session.ts` sent the directives, the voice
renderer handled them — and **nothing in the composition root ever called the first two**. Pressing
the key lit the chip and reached no session. It was invisible because the gap was in the wiring
rather than in any unit, and because the only end-to-end assertions were about the *unprompted*
path, which was wired. It is `shell.test.ts`'s `a question, end to end` now. *Why:* the general
shape is the one worth carrying — a seam that both sides implement is not a seam that is connected,
and "every layer has a test" is exactly the condition under which nobody writes the one that would
have caught it.

**2026-08-09 — the machine's phase, not the key events, is where a turn begins and ends.** The
composition root translates `armed`/`listening` → `beginPlayerTurn` and the exit from them →
`endPlayerTurn`, because the interaction machine is what resolves the gesture: push ends on release
and latch ends on the next tap, server VAD can end a turn with the key still held (ADR-0017), and a
barge-in goes from Speaking straight to Listening with no Armed in between. Reading key events
instead would be a second copy of all three rules. **`armed → listening` is the microphone opening,
not the gesture ending** — the first version of that block treated it as an end and cancelled every
turn a millisecond after it began, which presents as a chip that works and a Riki that never
answers.

**2026-08-09 — `PrivacyConfig` and `PrivacyPolicy` are different shapes on purpose, and the shell is
where they meet.** `@riki/config` has `{captions, unprompted, chatEgress, debugFrames}`;
`packages/context` takes `{allowChatText, allowPlayerNames}`. The mapping is one line in
`shell/index.ts`. *Why:* the assembler used to take `DEFAULT_PRIVACY` and ignore config entirely, so
`RIKI_CHAT_EGRESS` reached nothing at all. If you add a privacy field to either, the other does not
learn about it — check the mapping.

**2026-08-01 — a test that advances the world clock is also testing that every source went quiet.**
`self.*` expires at 60 s of game time and `enemies.*.position` at 20 s, so `world.advance(120)` then
asserting a render still contains something is asserting the opposite of what it looks like — the
facts are all expired and the section is omitted for a reason that has nothing to do with the test.
Pair every advance with a re-`put` of the facts under test. *Why:* it cost two rounds of confusing
red, and the failure reads as a broken renderer rather than as an aged-out world.

**2026-08-01 — `dropsWith` cannot be applied before composition, so the renderer composes twice.**
The `seen`/`unseen` pairing looks like a property of the ladder and is not: the composer drops one
section at a time by priority and re-measures, so it will cheerfully drop `unseen` and keep `seen`.
Which sections get dropped is not knowable until the budget has been measured against the text, so
closure is applied to `composed.omitted` and the survivors are re-composed, in a loop. *Why:* the
loop looks redundant on the way past and is the only thing making the pairing rule true. It
terminates because each pass drops strictly more, and in practice runs once or twice.

**2026-08-01 — `FakeWorldModel` coalesced `clock: null` to 600, so the pre-horn snapshot was
untestable.** `options.clock ?? 600` treats the one value a test passes on purpose as absent. *Why:*
general shape worth carrying — in a fake, `??` on any option whose `null` is meaningful silently
deletes the case somebody wrote the fake to reach.

**2026-08-01 — put a type in `common/` the moment a second directory names it.** The transitional
declarations here all collapse into `@riki/protocol` and `@riki/world-model` later, and one file to
edit beats three. Duplicating instead is silently fine until the package index re-exports both and
`tsc` reports TS2308 — which is how a second `UNSEEN_AFTER_SECONDS` was caught, a number that could
have drifted from the one deciding whether a position renders as an age or as `unseen >Ns`.

**2026-08-01 — deleting a directory means moving what is load-bearing out of it first, in its own
commit.** `tools/testing/` was imported by every test file in the package, so deleting `tools/`
first turned the whole package red at once — the worst position from which to work out what was
load-bearing. The same shape held for ADR-0042's much larger deletion. *Why:* two commits, and the
first one is boring on purpose.

**2026-08-01 — a design doc asking for a formatting optimisation can be asking for a coupling.**
dota2 §6.2 asked the snapshot to elide unchanged fields. An elided snapshot is a delta, a delta
needs its base to still be in the model's window, and the base is exactly what compaction drops — a
keyframe scheme with a silent failure mode, for an estimated ~120 tokens a turn. It shipped off and
was deleted unused with the retention policy. *Why:* before implementing anything that references a
previous turn, ask what happens when that turn has been compacted away.

**2026-08-01 — learnings get deleted with the code they are about.** Several here concerned the
command pipeline, the gate ladder, the coaching brief and the retention policy. All were hard-won
and all are now about nothing. They are in git history — `8b1a902~4` for the command pipeline,
2026-08-09 for the rest. *Why:* a learning about code that no longer exists is worse than no
learning; the next agent reads it as current and goes looking for the file.

**2026-08-09 — the snapshot is not a stopgap in practice, it is everything the model knows.**
`snapshot.ts`'s header calls itself a blob "kept working while the tools are built (T2–T4)", which
invites reading a gap in it as temporary. T4 has landed and it changed nothing in production: a live
session still sends `tools: []`, because nothing injects a `ToolDispatcher` and nothing can until
T12 puts the call across the preload boundary (ADR-0049, and the `voice-realtime` skill). So for now
— and for however long T12 takes — **a field missing from these ~300 tokens is a field the model
cannot obtain by any route.** Two were, and both looked like a rendering detail:

- `self-abilities.ts` printed `id + cooldown` and dropped `level`, so the skill build was invisible
  — and an unskilled ability rendered `backstab UP`, because Valve reports `can_cast: true` at
  level 0. A false statement, not just an omission.
- `world-view.ts` projects `self.items` filtered to `location === 'inventory'`, so the teleport and
  neutral slots reached nothing. "Do I have a TP" was unanswerable.

*Why:* the trap is that `WorldState` had all three the whole time — fusion maps every slot GSI
sends. Reading `read-gsi.ts` and concluding "we capture it" proves nothing about what the model is
shown. The cheap check is to render a real fixture and *read the text*: replay
`fixtures/gsi/laning-phase.jsonl` through `createWorldModelStore` → `toContextReader` →
`createSnapshotSource` in a throwaway test and print it. Four minutes, and it is the only view of
the snapshot that is the model's view.

## See also

[`conversational-architecture.md`](../../../docs/design/conversational-architecture.md) — the
current direction, and where the tool surface is specified;
[`conversational-migration-tickets.md`](../../../docs/design/conversational-migration-tickets.md) —
what is built and what is not;
`docs/design/context-and-memory-architecture.md` §5 — the snapshot, still current; the rest of that
document carries a ⚠ banner;
`docs/design/dota2-state-capture-design.md` §6.2 (the format), §7 (privacy);
`REPO_SKELETON.md` §5.3 Tier 2 (golden tests), §11 item 5 (where the persona lives — open, and the
question T8 has to answer).

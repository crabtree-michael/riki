# ADR-0038: A rehearsal is a coach turn against a world nobody is playing

**Status:** Accepted
**Date:** 2026-08-04

**Extends:** [ADR-0037](0037-the-inspector-is-a-control-surface-within-a-registry.md), whose last
alternative reads *"Actions as well as settings — 'force a tick', 'clear the latches', 'say this
now'. Each is useful and none is a setting … Left out, and left as a decision rather than an
extension."* This is that decision, taken for exactly one of the three.

## Context

ADR-0037 made the trigger numbers movable, which turned the inspector into a tuning surface. It did
not change what tuning *costs*, because every reading it produces still requires the moment that
produced it to happen:

> `speakThreshold` is now 0.25 instead of 0.3. What does the coach say about laning phase?

Reaching laning phase means playing or replaying a match. A live game reaches it once and leaves; a
replay reaches it on the timeline's schedule, and the latch set, the cooldown clocks and the
intensity fold all start from nothing each run, so the state that made a moment interesting has to be
rebuilt before the changed number means anything. `debug-inspector.md` §9's seventh open item is this
gap, and `coaching-architecture.md` §16 step 3 — *a reviewed diff to `config.ts`, justified against a
replayed corpus* — is the work it blocks.

What is missing is not another setting. It is the ability to ask a question:

> Here is a state. What would you say about it, and what were you looking at when you decided that?

Against that: ADR-0037's licence was explicitly *"the window can configure the app"*, and it named
*"the window can drive the app"* as a materially different claim it was not making. An action intent
makes that claim. This product's worst failure mode is Riki talking when it should not, and the
inspector is the only renderer a person can focus and type into — the widest privilege surface in the
app. A "force a turn" button that reached the live coaching root would put a debug window on the path
that ends at the player's headphones.

## Decision

**The inspector can run one coach turn on demand, against a mock game state, on a coaching root
built for the occasion and thrown away afterwards.** Four properties, each enforced rather than
remembered:

**1. It reaches none of the live match.** A rehearsal builds a scratch `WorldModelStore`, a scratch
`ContextAssembler` and a scratch `CoachDriver`, runs one consultation against them and disposes all
three. The fused facts the app is coaching on never see a mock payload; the latch set and cooldown
clocks somebody is watching in the Gate state panel do not move; the conversation Riki is actually
having is not appended to. `rehearsal.test.ts` asserts the store the rehearsal was never handed is
exactly where it was.

**2. It cannot make Riki speak.** No `CoachingSessionPort` is reachable from `rehearsal.ts`. There is
no path from the intent to `speakUnprompted` — which is the same refusal `shared/debug.ts` has always
made about the bridge, and it is why an action intent is acceptable at all where "say this now" is
not.

**3. A rehearsed turn is marked, everywhere it can be confused with a real one.** It lands in the
same buffer and renders through the same projection, so `DebugTurn.mockState` carries the state's id,
the outcome closes `rehearsed` or `declined` and never `spoke`, the turn ids are `rehearsal_N` from
their own counter, and the Coach turns panel draws a `mock:` pill. A window whose only job is to be
believed must not be able to offer a fabricated moment and a played one as the same claim.

**4. The state comes from a library, not from a path.** What crosses the bridge is an id; `get`
resolves it against a listing the library itself produced, so a name that was not offered does not
resolve to a read at all. The corpus is `fixtures/gsi/*.jsonl` — the same one `shell.test.ts` replays
and `pnpm dev:replay` drives the app with — read fresh on every frame, so a fixture dropped in while
the window is open appears in the dropdown without a restart.

The coach's own output is the point of the exercise, so `DebugTurn.guidance` carries the line the LLM
coach drafted, distinct from `agentSaid`, which is a transcript. On a rehearsal there is no
transcript, because nothing spoke.

## Consequences

**`CoachDriver` grows a `consult`.** Both implementations already had one — `EventEngine.evaluate`
and `LlmCoach.consult` are each documented as a test and replay affordance — and the port deliberately
did not expose it. The rehearsal is the caller that changed that: it asks a coach a question at a
moment no world-model version bump produced, which is precisely what neither push path can express.
It is `async` because one of the two is, and that is why nothing on the live trigger path may call
it: nothing there may await. ⚠ It mutates the coach that runs it, which is why the rehearsal runs it
on a coach built for the occasion.

**A mock state is a recording, not a moment.** A `.jsonl` is a timeline, and what the coach reads is
what the whole file fuses to — `draft.jsonl` is the draft as it stood at the last recorded POST.
Picking a point part-way through needs a second control and is left open.

**The recording is slid onto main's clock, not replayed at its recorded times.** A fixture's `atMs`
starts at zero and main's clock has been running since the app started; applied literally, every fact
would age to `expired` and the snapshot would render as an empty match. The last line lands on *now*
and every earlier one keeps its recorded distance behind it, so relative ages inside the state are
the recorded ones and the whole is as fresh as a live match's last POST. This is the subtlest part of
the component and the one whose first test did not actually catch it.

**The dropdown is a disclosure, not a `<select>`.** The document is rebuilt four times a second
(ADR-0032), so a native popup would be destroyed while open — the same fact that makes every control
on this screen a button (ADR-0037). Expansion and selection are renderer view state.

**One rehearsal at a time.** Under `llm` a run is a model call taking seconds and the button is one
click; two overlapping runs would interleave two turns into the panel, and `LlmCoach` refuses a
second consultation while one is in flight, so the second would report a skip that said nothing about
the state it was asked about. The port refuses with a reason instead.

**Absent by default.** A packaged build has no `fixtures/` beside it, so the library is empty and the
panel says how to populate it. A shell with no `mockStates` dep builds no rehearsal port at all, and
the intent is refused into the Problems panel rather than silently dropped.

## Alternatives considered

**A hand-authored set of named states in TypeScript.** Less code, and a second corpus: `shell.test.ts`
already replays `fixtures/gsi/`, the fixture headers already record whether a state was captured or
synthesised, and a scenario added to make the dropdown useful would then be one the suite could not
assert against. The cost of reusing the fixtures — a timeline where a moment would do — is stated
above rather than hidden.

**Run the turn on the live coaching root, against a swapped-in world.** Much smaller, and it gives up
property 1 entirely: the latches, cooldowns and ledger being watched would all move, so the reading
would be taken from an instrument the act of reading had disturbed. It also puts a debug window one
bug away from the session port.

**Let the rehearsal speak, behind a second confirmation.** The most requested version of this feature
and the one thing it must not do. "Riki talking when it should not" is the product's worst failure,
and a confirmation dialog is not an enforcement mechanism — an unreachable port is.

**Force a tick against the *live* world instead.** Cheaper, and it answers a different and much weaker
question: what the coach says about the state that already exists, which is the state the Triggers
panel is already showing four times a second. The value here is in choosing the state.

**A point-in-time cursor within a recording.** The right feature and a bigger one: it needs a scrubber,
a second control, and a decision about what "the state at line 40" means when fusion is order-
dependent. Left open in `debug-inspector.md` §9.

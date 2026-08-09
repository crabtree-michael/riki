# Proactive Coaching — Detection, Salience and the Gates

> ## ⚠ Superseded
>
> **Superseded by [`conversational-architecture.md`](conversational-architecture.md) /
> [ADR-0042](../adr/0042-riki-answers-questions-instead-of-deciding-when-to-speak.md), 2026-08-09.**
> `packages/events` and everything this document specifies — the eight detectors, the salience
> score, the thirteen gates, the intensity fold and the event tape — are **deleted**. Riki no longer
> decides when to speak; it answers when spoken to.
>
> **It is kept, not archived, because two things in it are still load-bearing.** §4's staleness
> reasoning — *"say 'was bottom thirty seconds ago', not 'is bottom'"* — is the one part of the
> deleted machinery worth keeping verbatim, and it is where T8's system prompt comes from. And §5.4
> is the record of *why* the ladder failed: on 2026-08-09, in 152 world-model ticks, Riki spoke once
> and eighty-five candidates died at a single gate that had armed itself and could not release.
> A document that only says what was built cannot say that.
>
> Read it as history. Nothing below describes code that exists.

**Status:** Accepted under [ADR-0023](../adr/0023-coaching-replaces-command-execution.md), and
**built** — `packages/events` and the composition root in `apps/desktop/src/main/agent/` are
[`coaching-architecture.md`](coaching-architecture.md) §16 steps 6 and 7, and both have landed.
Step 8, tuning, is open and is where every coefficient in §4 gets its first real number.
**Scope:** The half of coaching that decides *whether Riki speaks and about what*: event detection
over the world model, the salience score, the thirteen gates that refuse, the mid-fight intensity
signal, the event tape, and the composition root that puts the two halves in one process.
**Reads with:** [`coaching-architecture.md`](coaching-architecture.md) — the sibling document, which
owns the *content* half (the coaching brief, `BRIEF_PLAN`, the budgets, and the record of what the
deletion removed). Its §6 is the thin version of this document and defers to it throughout; §6.6 is
the seam between the two, and it is closed. `dota2-state-capture-design.md` §6.4 is the product
policy this builds out. [`state-capture-architecture.md`](state-capture-architecture.md) §7.1 is
still the only way a game fact reaches this component.
[`context-and-memory-architecture.md`](context-and-memory-architecture.md) §6.3 owns
`CoachingMemoryReader`, which is the novelty gate's whole input.
**Out of scope:** What the model is shown once a turn is admitted (that is the brief,
`coaching-architecture.md` §4–§5), the wire protocol and session lifecycle (`packages/realtime`),
fusion and derived state (`packages/world-model`), and the persona text (open question 5).

> **A note on this document's history, because it explains its shape.**
>
> ADR-0023 and `coaching-architecture.md` were written against a `coaching-trigger-architecture.md`
> that was described as "in flight" and was never committed. Both documents quote it in detail —
> the eight-member `CoachEventKind` union, the `kind weight × instance magnitude × urgency`
> decomposition, the thirteen-member `SuppressionReason` union with `latched`, `agent_speaking` and
> `not_in_match` named individually, and the `packages/events` directory layout — and both defer to
> it on four specific points recorded in that document's §6.6.
>
> This document is that spec, written from those constraints rather than recovered. Where
> `coaching-architecture.md` quotes the in-flight design, this document matches the quotation
> exactly; that is the whole reason the quotations were treated as binding rather than as
> suggestions. Everything the two documents did not already agree on is decided here and marked.

---

## 0. Assumptions

House style. Sections marked ⚑ are what changes if one is wrong.

| # | Assumption | Source | Affects |
|---|---|---|---|
| T1 | **⚑ Coaching is proactive**, and this package is the only producer of an unprompted turn | ADR-0023, coaching §P2 | ⚑ everything |
| T2 | The world model is the only source of game facts, and it already carries provenance, confidence and age | state-capture §7.1 | §3, §4.3 |
| T3 | The memory layer is built. `CoachingMemoryReader` is the novelty gate's only input, and it reasons in **game clock** | context-and-memory §6.3 | §5.1 |
| T4 | ⚑ **The default is silence.** A gate that is unsure refuses | dota2 §6.4 | ⚑ §5 |
| T5 | Numbers marked *(tunable)* are starting points with no measurement behind them | coaching §P8 | §4.5 |
| T6 | The player's own screen is out of reach: no enemy health, no fog-of-war peeking | dota2 §8.2 | §3.2's absent ninth detector |

**T4 is the only idea in this document that is not mechanical.** dota2 §6.4's closing line — *"the
feature most likely to make Riki annoying enough to uninstall"* — is a statement about which
direction to fail in, and every structural choice below is that line applied: gates are ordered
cheapest-and-most-absolute first, a detector that cannot answer honestly emits nothing rather than a
low-confidence guess, an unclear novelty verdict counts as *already said*, and a trigger arriving
during an open turn is dropped rather than queued.

---

## 1. What this is

`packages/world-model` knows what is true. `packages/context` knows what the model should be shown
and what Riki has already said. `packages/realtime` knows how to hold a conversation. The gap
between them is one question:

> **Is now a moment worth speaking about, and about what?**

That question decomposes into four things that must not be folded into each other, and most of this
document is the argument for keeping them apart:

```
   world model version bump
          │
          ▼
   ┌──────────────┐   conditions currently true, with a magnitude and a deadline
   │   detect     │──────────────────────────────────────────────────┐
   └──────────────┘                                                  │
          │                                                          ▼
          │                                              ┌────────────────────┐
          ▼                                              │    event tape      │  the snapshot's
   ┌──────────────┐   one number, comparable across kinds │  (recent: line)    │  `recent:` line
   │   salience   │                                       └────────────────────┘
   └──────────────┘
          │
          ▼
   ┌──────────────┐   thirteen reasons to refuse, in order, each counted
   │    gates     │──── refused ──► counter++, ledger `turn_closed: 'silent'`
   └──────────────┘
          │ admitted — at most one
          ▼
   CoachEvent { id, topic, salience } ──► composition root ──► openTurn ──► brief ──► speech
```

**Detection says what is true. Salience says how much it matters. The gates say whether to say it
anyway.** Folding any two together is the mistake this design is built to avoid, and the specific
failure each folding produces is in §5.2.

---

## 2. Vocabulary

Declarations; the shapes are the contract. Implementations are `packages/events/src/types.ts` and
`contracts.ts`.

```ts
/**
 * Eight, not dota2 §6.4's nine. `tower_diveable` is absent because it needs the enemy's health,
 * which the world model does not carry and which under the §8.2 fairness rule could only come from
 * the player's own screen. Shipping a detector that can never fire would read as coverage.
 */
export type CoachEventKind =
  | 'enemy_missing' | 'ult_ready' | 'can_afford_key_item' | 'low_hp_no_escape'
  | 'rune_soon' | 'enemy_core_dead_window' | 'stack_now' | 'buyback_unaffordable';

/** Identifies one *instance* of a condition, and it is the latch key (§5.3). `enemy_missing:sf`. */
export type DetectionKey = string & { readonly __brand: 'DetectionKey' };

/** What a detector produces. Facts about the moment; no score, no decision. */
export interface Detection {
  readonly kind: CoachEventKind;
  readonly key: DetectionKey;
  readonly topic: AdviceTopic;
  /** 0..1. How big is *this* instance of this kind — the detector's number, not the scorer's. */
  readonly magnitude: number;
  /** Seconds for which the advice stays actionable. `null` means no deadline. */
  readonly actWithinSeconds: number | null;
  /** The minimum confidence of the facts behind it (§4.3). */
  readonly confidence: number;
  /** Already natural language, for the tape (§6). The model never sees this on the trigger path. */
  readonly text: string;
  readonly atGameClock: GameClock | null;
}

/** A detection that has been scored. Still not a decision. */
export interface CoachEvent {
  /** The kind, as `packages/context`'s `EventId`. This is what `BRIEF_PLAN` keys on. */
  readonly id: EventId;
  readonly kind: CoachEventKind;
  readonly key: DetectionKey;
  readonly topic: AdviceTopic;
  readonly salience: number;
  readonly detection: Detection;
  readonly at: MonoMs;
}

/** Thirteen, exhaustive, individually counted. §5.1. */
export type SuppressionReason =
  | 'not_in_match' | 'quiet_mode' | 'muted' | 'agent_speaking' | 'player_speaking'
  | 'high_intensity' | 'latched' | 'kind_cooldown' | 'global_cooldown'
  | 'already_advised' | 'ignored_twice' | 'stale_window' | 'below_threshold';

export type TriggerDecision =
  | { readonly speak: true; readonly event: CoachEvent }
  | { readonly speak: false; readonly reason: SuppressionReason; readonly event: CoachEvent | null };
```

**`TurnCause` is not changed, and `AdviceTopic` is not redefined.** `coaching-architecture.md` §4.3
settled the first — the composition root's adapter is a field copy — and ADR-0013 settled the
second: `AdviceTopic` is a closed union owned by `packages/context`, and a second topic vocabulary
here would be two tables that must agree about what "the same advice" means. `Detection.topic` is
that type, imported, and it is the one value that reaches three consumers from one origin: the
brief planner, the novelty gate, and `agent_said.topics`.

---

## 3. Detection

### 3.1 Detectors read a snapshot; deltas decide *when* to look

`coaching-architecture.md` §5.1 says `packages/events` "reads deltas rather than snapshots", and
that a delta is "what makes `enemy_missing` a *transition* rather than a state, which is what makes
it worth speaking about once". The first half is right about the *trigger* and the second half turns
out to be right about the *outcome* rather than about the mechanism. This design splits them:

- **A delta decides when to evaluate.** The engine subscribes to `WorldModelReader.onVersion`, so
  detection runs when something actually changed and never on a timer. That is where the coalescing
  property comes from, exactly as it does for derived state (state-capture §5.7).
- **A detector is a pure function of the snapshot** and returns *the conditions currently true*.
- **The latch turns "continuously true" into "said once"** (§5.3).

The reason not to write detectors against deltas directly is the one `coaching-architecture.md` §6.3
already names: a cooldown *cannot tell a recurrence from a persistence*, and neither can a
delta-diffing detector — it sees an edge, and an edge is not the same as a condition being newly
worth mentioning. A hero who goes missing, is glimpsed on a ward for one frame, and goes missing
again produces two edges and one situation. The latch gets that right for free and a diff does not.

The cost of the choice is stated rather than mitigated: a detector cannot see *how fast* something
changed. Exactly one thing in this design needs that, and it is not a detector — it is the intensity
signal, which is a fold over deltas and lives in its own file for that reason (§7).

```ts
export interface EventDetector {
  readonly kind: CoachEventKind;
  /** Pure, total, and allocation-light: it runs on every version bump. */
  detect(world: WorldSnapshot, cfg: TriggerConfig): readonly Detection[];
}
```

### 3.2 The eight

Each is one file-worth of logic in `detect/`, grouped four ways by what they read. The column that
matters most is the last one: **what it does when the fact it needs is missing**, because for six of
the eight the answer is "nothing at all", and a coach that says nothing is the design working.

| Kind | Fires when | Magnitude from | Deadline | Absent input → |
|---|---|---|---|---|
| `enemy_missing` | `derived.unseenEnemies` holds a hero unseen ≥ `missingAfterSeconds`, not known dead | age, scaled by how many are simultaneously missing | none | no CV sidecar → no positions → never fires. Riki says less rather than something wrong |
| `low_hp_no_escape` | alive, HP fraction ≤ `lowHpFraction`, no castable escape item, ≥ 1 enemy with a *fresh* position | how far below the threshold | `lowHpActWithinSeconds` | no `self.health` → never fires |
| `ult_ready` | alive, an ultimate is `castable` at level ≥ 1, **and** ≥ 1 enemy has a fresh position | fixed; this kind's weight is what ranks it | none | no `self.abilities` → never fires |
| `enemy_core_dead_window` | an enemy is known dead with `respawnIn` ≥ `deadWindowSeconds` | respawn time remaining | **none** — see §4.2 | scoreboard CV only; absent → never fires |
| `can_afford_key_item` | `derived.goldUntilItem.remaining === 0` | fixed | none | **no build target → never fires.** §3.3 |
| `buyback_unaffordable` | alive, `derived.buybackAffordable.affordable === false`, short by ≤ `buybackShortfallGold` | how close the player is | none | no `self.buyback` → never fires |
| `rune_soon` | `derived.runeTimings` puts a power or bounty rune within `runeLeadSeconds` | rune type | the seconds until it | clock-only; fires whenever there is a clock |
| `stack_now` | `derived.stackTiming.nextStackIn` ≤ `stackLeadSeconds` | fixed | the seconds until it | clock-only |

Three of these carry a decision that is not obvious from the row.

**`ult_ready` requires a visible enemy, and that is the difference between coaching and an alarm
clock.** "Your ult is up" said to someone farming an empty lane is the single most irritating thing
this package could produce — it is true, it is useless, and it is available to say every few seconds
for the rest of the match. Requiring a fresh enemy position makes it advice about a fight that might
happen. It also means the detector inherits the CV sidecar's availability, which is the correct
trade: with no positions there is no fight to advise about.

**`low_hp_no_escape` decides "no escape" from a list of item ids in config, not from the ability
list.** `AbilityState` carries no "is this an escape" flag and the world model has no reason to grow
one; item ids are a small closed list (blink, force staff, glimmer, eul, and the TP scroll) and they
live in `TriggerConfig` so there is one place to fix when a patch moves them. This is deliberately
approximate — a Storm Spirit with mana is not trapped and this detector thinks he is — and the
mitigation is the salience weight, not a cleverer detector. The alternative is hero-specific ability
knowledge, which is reference data, and reference data has exactly one consumer in this product and
it is the preamble (coaching §5.3).

**`enemy_missing` emits one detection per hero, not one for the group.** Per-hero is what lets the
topic be `{ of: 'hero', hero }`, which is what makes the novelty gate able to say "I already told you
about SF". The group is not lost: magnitude scales with how many are missing at once, so three
missing heroes rank above one, and §5's "one trigger, one utterance" means only the top-ranked one
is ever spoken.

### 3.3 `can_afford_key_item` fires only when something told us what to save for

`derived.goldUntilItem` answers `null` until `GoldUntilItemOptions.target` is set, and
`packages/world-model` is explicit that this is on purpose: *"There is no way to know this from the
world model … so the rule answers null until something tells it, rather than picking an item on the
player's behalf."* The thing that tells it is the build benchmark in the preamble, which the
composition root feeds in at draft.

So this detector is dark until the composition root wires a target, and that is worth stating rather
than hiding: it is the one detector whose silence means *"nobody configured me"* rather than
*"nothing is happening"*. §10 gives it a row, and the engine counts detections per kind so a kind
that never fires in a whole match is visible rather than assumed working.

---

## 4. Salience

### 4.1 The decomposition

One number, comparable across kinds, so that the gates and the ranking have something to be a
threshold on:

```
salience = kindWeight[kind] × magnitude × urgency × confidence × tendency
```

Five factors, each owned by exactly one place, and the ownership is the point:

| Factor | Range | Owned by | Why it is separate |
|---|---|---|---|
| `kindWeight` | 0..1 | `config.ts` | The only *policy* number. Tuning changes this and nothing else |
| `magnitude` | 0..1 | the detector | Only the detector knows that 40 s missing beats 21 s missing |
| `urgency` | 0..1 | §4.2 | A function of the deadline and of how long speaking takes |
| `confidence` | 0..1 | the world model | §4.3. Dropping it makes the confidence gate decoration |
| `tendency` | 0..1+ | durable memory | §4.4. The only place coaching adapts to a *person* |

**Cooldowns are not in here, and that is the load-bearing separation.**
`coaching-architecture.md` §4.4 records the argument and it is right: folding a cooldown into a
score makes the threshold untunable, because the same number then means "this is not important" and
"this is important but I said it recently", and no single threshold can be correct for both. A
cooldown is a gate, it has its own counter, and the ratio of `global_cooldown` refusals to spoken
turns is a tuning signal that would be invisible if it were arithmetic.

### 4.2 Urgency, and the fact that speaking is not instant

```ts
const effective = actWithinSeconds - speakLatencySeconds;
urgency = actWithinSeconds === null ? noDeadlineUrgency
        : effective <= 0            ? 0
        : horizonSeconds / (horizonSeconds + effective);
```

Two things fall out of this and both matter.

**Advice that would arrive after its window closed scores zero**, which is
`coaching-architecture.md` §6.2's requirement, made concrete by subtracting the time it actually
takes to say something. `voice-input-architecture.md` §7 puts the conversational latency floor at
1–1.5 s, so `speakLatencySeconds` defaults to 1.5 *(tunable)* — and a stack reminder with 1 s left
on it is not a slightly worse stack reminder, it is a wrong one. Zero urgency drives salience to
zero, which the last gate turns into a `stale_window` refusal with a counter on it.

**Nearer is more urgent**, hyperbolically rather than linearly: with a 15 s horizon, a deadline
16.5 s out scores exactly 0.5 and one 60 s out scores about 0.2. Linear decay over a fixed window
has to pick a window length, and any choice makes everything beyond it identical; the hyperbola
never reaches zero on its own, which leaves "expired" as the only thing that does.

A detection with no deadline is not urgent and not un-urgent. `noDeadlineUrgency` is a flat
*(tunable: 0.85)* and it exists so that `enemy_missing` — which has no deadline and is one of the two
most valuable things this package can say — is not structurally out-ranked by every rune spawn.

**⚑ This models lateness risk, not importance, and two kinds needed the distinction.** Fed a
*window* rather than a deadline — "their carry is dead for fifty seconds" — the curve does the
opposite of what is wanted: a longer window is more valuable and *less* urgent, so multiplying the
two cancels exactly the thing that made the moment worth mentioning. So `actWithinSeconds` means
**"this advice stops being useful in N seconds"**, and `enemy_core_dead_window` and `enemy_missing`
answer `null` and put the size of the opportunity in `magnitude` instead. A window *opening* is not
a deadline; only a window *closing* is. §12 carries the shape of the curve as unverified, and this
is the first thing to look at if the ordering comes out wrong.

### 4.3 Confidence is a multiplier, and this is the one that must not be dropped

`coaching-architecture.md` §6.2's first addition, adopted verbatim: *"A CV-derived detection at 0.55
confidence is worth less than the same detection from GSI … if salience drops it, the confidence
gate becomes decoration at exactly the point it matters most."*

`Detection.confidence` is the minimum confidence of the facts the detector actually read — the same
rule `derivedFact` uses in `packages/world-model`, for the same reason. A position from GSI is
1.0 and multiplies by nothing; a minimap blob at 0.55 nearly halves the score. It is a multiplier
rather than a gate because the right response to a half-confident detection is *to rank it below a
certain one*, not to discard it: the brief will render it with its age and confidence attached
(`AgeFormatter`, coaching §4.3), so a hedged statement is reachable and a false certainty is not.

`salience.test.ts` asserts this directly, because it is the row of `coaching-architecture.md` §13
that names this document.

### 4.4 Advice tendency, read once

The fourth input is durable: `PlayerMemory.adviceTendency` (ADR-0013). A player who has ignored rune
reminders across four matches should hear fewer of them.

It is a **preamble-time read, not a per-turn one** — `coaching-architecture.md` §6.2 is explicit —
so it enters this package as a frozen lookup injected at construction:

```ts
export type TendencyIndex = (topic: AdviceTopic) => number;
```

The default is `() => 1`, which is the identity, and that is what a first-ever match gets. It costs
nothing on the hot path because there is no hot-path work: the function was resolved before the
session opened.

This is the only place proactive coaching adapts to a person rather than to a game, and it is most
of the argument for durable memory being worth a persistence surface at all
(context-and-memory §6.4).

### 4.5 The coefficients are not decided here, and shipping them anyway is not a contradiction

`coaching-architecture.md` §6.2 refuses to give coefficients, and §15 item 1 and §16 step 8 say why:
*"they are unmeasurable without a replayed corpus and a human judging the output, and a number
written down would be treated as decided."*

That refusal is about **authority**, not about the existence of numbers — code cannot run without
them. So every one of them is in `config.ts`, in one exported object, each marked *(tunable,
unmeasured)*, and nothing else in the package contains a numeric literal that affects behaviour.
The tuning ticket is then a diff to one file with a golden corpus behind it, rather than a hunt
through eight detectors.

What the defaults encode is a *shape*, and the shape is a claim worth arguing with even before the
numbers are measured:

| Kind | Weight | Because |
|---|---|---|
| `low_hp_no_escape` | 1.00 | The only one where being late is the same as being wrong |
| `enemy_missing` | 0.85 | dota2 §6.2's own example of the highest-value thing to say |
| `enemy_core_dead_window` | 0.60 | Opens an objective window; valuable and not urgent |
| `can_afford_key_item` | 0.55 | Actionable, and the one with an observable outcome (§5.1) |
| `buyback_unaffordable` | 0.50 | Matters most in the late game, which the deadline cannot express |
| `rune_soon` | 0.48 | Frequent. Frequency is what the cooldown is for, not the weight |
| `stack_now` | 0.42 | Cheap value, and easy to make annoying |
| `ult_ready` | 0.38 | Lowest, because it is the easiest to say too often |

Against a `speakThreshold` of 0.30 those weights put a single hero unseen for ~33 s over the bar,
three unseen immediately, a rune about 11 s out, and a stack about 6 s out. **Every one of those
five numbers is a consequence of the table rather than a decision**, which is the property worth
keeping: there is one place to turn, and the second-order effects follow.

The ordering is the claim. The gaps are guesses.

---

## 5. The gates

### 5.1 Thirteen reasons, in the order they are asked

Every gate is a pure function of `(candidate, GateContext)`. The first one that refuses wins,
supplies the reason, and increments its own counter.

| # | Reason | Refuses when | Reads |
|---|---|---|---|
| 1 | `not_in_match` | no live match, or a mode where the advice would be wrong | `meta.phase`, `meta.mode` |
| 2 | `quiet_mode` | "only when I ask" is on | local command state |
| 3 | `muted` | the player muted Riki, and the mute has not expired | local command state |
| 4 | `agent_speaking` | a turn is already open | the composition root |
| 5 | `player_speaking` | the player is talking | `packages/audio`, via the session |
| 6 | `high_intensity` | mid-fight | §7 |
| 7 | `latched` | this exact condition has been continuously true since Riki last mentioned it | §5.3 |
| 8 | `kind_cooldown` | this kind was spoken within its own cooldown | §5.3 |
| 9 | `global_cooldown` | anything was spoken within the global cooldown | §5.3 |
| 10 | `already_advised` | this topic was raised recently and the player acted on it | `CoachingMemoryReader.recent` |
| 11 | `ignored_twice` | this topic was raised twice and ignored both times | `CoachingMemoryReader.recent` |
| 12 | `stale_window` | urgency is zero: the advice would arrive after its window closed | §4.2 |
| 13 | `below_threshold` | salience is under `speakThreshold` | §4 |

`not_in_match` covers two different things under one counter deliberately. No live match is the
obvious half; the half that earns the gate is **mode** — Riki confidently coaching Ability Draft on
standard ability timings, or Turbo on standard rune and gold timings, is a failure mode that looks
exactly like working software. The allowed-mode list is config, and an *unknown* mode is allowed,
because failing closed on a mode string Valve renamed would silently disable the product.

`already_advised` and `ignored_twice` are dota2 §6.4's novelty gate split in two, because they are
different signals and want different counters: the first says the coaching worked, and the second
says the player does not want this kind of coaching. Both read `CoachingMemoryReader`, whose `within`
is **seconds of game clock** measured from the ledger's latest known clock (context-and-memory §6.3)
— which is why the cooldowns in §5.3 that involve memory are in game seconds and the ones that do
not are in monotonic milliseconds. Conflating the two scales is the easiest mistake available here
and it is invisible until a match pauses.

### 5.2 Why the order is the design

The order is not preference. It is three rules:

1. **Absolute before conditional.** `quiet_mode` and `muted` are the player's explicit instruction.
   They are asked before anything about the game so that "only when I ask" cannot be defeated by a
   bug in a game-state gate, and so that its counter is unambiguous.
2. **Cheap before expensive.** `not_in_match` is two field reads; `already_advised` projects the
   ledger. The gate ladder runs on every version bump.
3. **Attribution before convenience.** A trigger refused during a teamfight *and* under cooldown is
   counted as `high_intensity`, because that is the reason a human tuning the thresholds needs to
   see. §5.4 is why this matters more than it looks.

The three foldings this ordering exists to prevent, each of which is a real temptation:

- **Salience absorbing the cooldown** — §4.1. One threshold cannot mean two things.
- **The latch absorbing the cooldown** — §5.3. They answer different questions and a system with
  only one of them is broken in a way that only shows up over a whole match.
- **The gates absorbing detection** — a detector that checked "have I said this" would make the
  novelty policy untestable without a ledger, and would put a memory read inside a function that
  runs on every version bump.

### 5.3 The latch and the cooldown are not the same thing

This is the distinction `coaching-architecture.md` §6.3 flagged as the one both documents had
missed, and it is worth its own section.

- A **cooldown** answers *"how long since I last said this kind of thing?"* It is a rate limit, and
  it is what stops six rune reminders in a minute.
- A **latch** answers *"has this exact condition been true without interruption since I mentioned
  it?"* It is not a rate limit at all.

Without the latch, "your ult is up" is said, the cooldown expires, the ult is still up, and Riki
says it again — forever, at the cooldown's period, for as long as the player does not cast it. No
cooldown length fixes this: too short and it repeats, too long and a genuinely *new* ult-ready
moment twenty minutes later is suppressed.

The mechanism is `DetectionKey`. When Riki speaks about a detection, its key is latched. The latch
clears when the key stops appearing in the detector's output — the condition became false — and not
before. That is why `DetectionKey` identifies a condition *instance* (`enemy_missing:sf`) rather
than a kind, and it is the only reason the type exists.

Latches are also bounded in game time (`latchExpirySeconds`, *tunable*), for the one case the clean
version gets wrong: a condition that is true for twenty minutes because nothing about the game
changed is, eventually, worth mentioning again.

### 5.4 Every refusal is recorded, and that is the tuning signal

`coaching-architecture.md` §6.3's one demand of this document: *"every refusal is recorded, so that
'Riki said nothing' is never indistinguishable from 'Riki noticed nothing'."*

Two things record it, and neither is optional:

- **A per-reason counter** in this package, exposed as a frozen
  `Readonly<Record<SuppressionReason, number>>`.
- **A ledger entry** in `packages/context` — `turn_closed: 'silent'` — appended by the composition
  root, so the record survives a compaction and a reconnect exactly as every other coaching fact
  does (ADR-0012). It records **transitions**, not instants:
  [ADR-0024](../adr/0024-suppression-is-counted-the-ledger-records-transitions.md) is why, and the
  reason is not tidiness — the gates run on every version bump, and `CoachingMemory`'s memo is keyed
  on the ledger version, so a per-refusal append would make the novelty gate re-walk a growing array
  on every tick.

**The ratio of triggers detected to turns spoken, broken down by which gate refused, is the primary
tuning signal under a proactive product**, and `coaching-architecture.md` §12 row 2 cannot be
answered without it. A build where 95 % of refusals are `below_threshold` has a threshold problem; a
build where they are `high_intensity` has an intensity problem; a build where they are `latched` is
working correctly and is detecting things that stay true.

The engine also counts *detections per kind*, which is the other half: a kind that never fires in a
whole match is either impossible to trigger or unwired (§3.3), and neither is visible from
suppression counters alone.

### 5.5 One trigger, one utterance

Two rules, both from `coaching-architecture.md` §6.5, and both structural here rather than
remembered:

- **A trigger that fires while a turn is open is dropped, not queued.** That is gate 4, with a
  counter. Queueing means speaking about a moment that has passed, and dota2 §6.4's real complaint
  about unprompted speech is not that there is too much of it but that it arrives late. A
  player-initiated turn is not affected: it does not come through this package at all, it pre-empts,
  and the composition root routes it directly (§9.3).
- **Only the highest-salience candidate on a tick is considered.** Detection produces a set; the
  policy ranks it and asks the gates about the winner. It does not fall through to the runner-up:
  the gates that would have refused the winner are mostly about *Riki*, not about the candidate, so
  a fall-through would say something less useful for a reason that applies equally to it.

### 5.6 An empty brief consumes the cooldown, deliberately

`coaching-architecture.md` §6.5: a brief that renders nothing is a turn that does not happen. So the
composition root can admit a trigger, render an empty brief, and close the turn `'silent'` — after
this package has already armed the latch and the cooldowns for it.

That is the intended behaviour and not an oversight. The alternative — retracting the latch when the
brief comes back empty — re-fires the same detection on the very next version bump, renders another
empty brief, and loops. Consuming the cooldown costs at most one missed moment; the retraction costs
a hot loop in the component whose whole job is to be quiet. §10 gives it a row and the counter that
makes it visible.

---

## 6. The event tape

`packages/context`'s snapshot has a `recent:` line, and it arrives through `EventTapeReader` — a
port *that package declares and this one implements*, wired in the composition root
(context-and-memory §8.2). That inversion is what keeps `packages/context` free of any import of
`@riki/events` while the data flows the way dota2 §3's diagram says.

```ts
export interface EventTape {
  /** The last n typed events, newest last, already salience-ordered. */
  recent(n: number, since: GameClock | null): readonly TapeEvent[];
  record(event: CoachEvent): void;
}
```

**The tape records detections, not utterances**, and that is the whole point of it. The snapshot's
`recent:` line is *what has been happening in this match*, and it must not become *what Riki chose
to talk about* — a model shown only the things it already said has no idea what it missed. So
anything clearing `tapeSalience` (*tunable*, well below `speakThreshold`) is taped whether or not it
was spoken, and the gates do not touch it.

The one gate that does apply is `not_in_match`, for the same reason it is gate 1: a tape entry about
an Ability Draft timing is wrong rather than merely unspoken.

`recent(n, since)` takes the top `n` by salience and then orders them newest last, which is what the
port's own documentation asks for and reads oddly until you see why: **priority decides what
survives the budget, and chronology decides how it reads.** The snapshot renderer truncates the tape
first when the budget is tight (context-and-memory §5.2), so the tape must hand it the most
important ones — but a list of events in salience order reads as a ranking rather than as a
narrative, and the model would draw an ordering conclusion that is not there.

---

## 7. Intensity

The one signal that genuinely needs deltas rather than snapshots (§3.1), and the reason it has its
own file.

dota2 §6.4 specifies the inputs: *"Detect via HP deltas, nearby enemy count, ability usage rate."*
All three are folded over a rolling window of `WorldDelta`s:

| Input | Read from | Contributes |
|---|---|---|
| HP swing | successive `self.health` facts in the window | the sum of downward movement, as a fraction of max |
| Nearby enemies | enemies with a *fresh* position within `nearbyRadius` of `self.position` | count, saturating |
| Ability usage | `self.abilities` transitions from castable to not | count, saturating |

The score is the maximum of the three normalised terms rather than their sum, because they are three
different pieces of evidence for the same thing and not three things that add up: someone at full
health surrounded by four enemies who has cast nothing is in a fight, and so is someone alone who
just lost 60 % of their HP.

**It decays on the wall clock and is folded on the game clock.** The window is game-time
(`intensityWindowSeconds`) so that a pause does not manufacture calm, which is the same two-clock
rule `packages/world-model`'s staleness policy holds and for the same reason.

`packages/context`'s compactor also wants a quiet moment (context-and-memory §7.3) and reaches for
the same idea. It gets it from the world model's derived state rather than from here — this package
does not export a signal to another package's scheduler, and two consumers of one number across a
package boundary is a coupling neither design asked for.

---

## 8. The engine

The one stateful object, and the only thing in the package that subscribes to anything.

```ts
export interface EventEngine {
  /** Subscribes to the world model. Returns the unsubscribe. */
  start(): Unsubscribe;
  /** At most one per version bump, already gated. */
  onCoachEvent(listener: (event: CoachEvent) => void): Unsubscribe;
  /** Every refusal, for the ledger's `turn_closed: 'silent'` entry (§5.4). */
  onSuppressed(listener: (reason: SuppressionReason, event: CoachEvent | null) => void): Unsubscribe;
  readonly tape: EventTape;
  counters(): TriggerCounters;
  /** What the composition root knows and this package cannot see. */
  setAgentSpeaking(speaking: boolean): void;
  setPlayerSpeaking(speaking: boolean): void;
  setQuietMode(on: boolean): void;
  setMuted(untilMs: MonoMs | null): void;
  dispose(): void;
}
```

The four setters are the whole of this package's mutable input from outside the world model, and
they are setters rather than a subscription because the composition root is the only writer and
because a gate reading a stale "is the agent speaking" is the one piece of state where being wrong
produces the failure the gate exists to prevent.

`start()` is separate from construction so that a test can build an engine, arrange the world, and
then attach — which is what makes the whole gate ladder assertable without a fake subscription.

---

## 9. The composition root

`apps/desktop/src/main/agent/`, proposed by both existing design documents and never created until
now. This is `coaching-architecture.md` §16 step 7, and it is the first point at which the two
halves of coaching are in the same process.

### 9.1 What it wires

```
@riki/gsi ─┐
@riki/log-tail ─┼─► @riki/world-model ──┬──────────────────────────────► @riki/events
sidecar ────────┘                       │                                    │
                                        │  world-view.ts (§9.2)              │ CoachEvent
                                        ▼                                    ▼
                                @riki/context ◄──── EventTapeReader ──── EventTape
                                        │
                                        │ TurnContext { snapshot, brief }
                                        ▼
                                 @riki/realtime ──► speech ──► overlay: Speaking(unprompted)
```

Four adapters, one file each, and nothing else:

| File | Adapts | Because |
|---|---|---|
| `world-view.ts` | `@riki/world-model`'s `WorldSnapshot` → `@riki/context`'s | The two mirror each other; §9.2 |
| `tape.ts` | `EventTape` → `EventTapeReader` | The port inversion in §6 |
| `intents.ts` | `VoiceEvent` → turns, ledger entries and engine state | §9.3 |
| `index.ts` | the coaching turn itself | The only place `openTurn` is called |

### 9.2 The world view — a projection keeps the envelope, a comparison does not

`packages/context`'s `common/ports.ts` predicted this file: *"Mirrors `WorldSnapshot` in
packages/world-model/src/snapshot.ts, except that reads come back as `Observed<T>` rather than that
package's `StaleFact<T>` … collapsing them is one adapter in the composition root."* It is that
adapter, and the collapse is mechanical.

What is not mechanical is that `packages/context`'s sections read about forty field paths that it
invented, and `packages/world-model` supplies about half of them under different names. The rule
this adapter holds, and the reason it is allowed to do any work at all:

> **A projection of one fact keeps that fact's envelope. A comparison of two facts is a derived
> rule, and it belongs in `packages/world-model`.**

`self.hpPct` is `self.health`'s `current/max` — one fact in, one fact out, same source, same
confidence, same age. `derived.nextRuneAt` is a field selected out of `derived.runeTimings`. Those
are renames with a shape change, and doing them here keeps two packages' vocabularies from having to
be identical before either can ship.

`derived.threats` and `derived.pace*` are not projections. "Can that hero reach me" is arithmetic
over two positions, a movement speed and a set of blinks, with its own confidence; "am I behind" is
a net worth compared against a benchmark. Computing either here would produce a number with no
provenance sitting next to numbers that have some, which is the exact failure
`coaching-architecture.md` §5.5 and `state-capture-architecture.md` §5.7 both forbid. So they are
**left unsatisfied**, the sections that read them are omitted and recorded, and the work is named as
`packages/world-model`'s in §15.

That is the designed degradation rather than a shortcut: `CoachingBrief.omitted` carries them,
telemetry counts them, and a brief with nothing left becomes a silent turn rather than a confident
one.

### 9.3 Voice intents

The other half of step 7, and the half `coaching-architecture.md` §7.3's routing table describes
without saying where the code lives. It lives in `intents.ts`, and it is a translation table:

| `VoiceEvent` | Routes to |
|---|---|
| `command: 'quiet-mode'` | `engine.setQuietMode(true)` — the off switch for the primary path (§7.1) |
| `command: 'mute'` | `engine.setMuted(now + minutes)`; the machine mutes the chip |
| `command: 'stop'` | `session.abort()`, and `closeTurn('cancelled')` |
| `command: 'cancel'` | `closeTurn('cancelled')` |
| `speech: 'resumed' \| 'silence'` | `engine.setPlayerSpeaking` — gate 5 |
| `turn: 'responseStarted' \| 'responseEnded'` | `engine.setAgentSpeaking` — gate 4 — and `closeTurn('spoke')` |
| `transcript` (player, final) | `ledger.append({ kind: 'player_said' })` |
| `transcript` (agent, final) | `ledger.append({ kind: 'agent_said', topics })` — **topics from the trigger** |

And the one that is a turn rather than a control:

> **A push-to-talk gesture is a call to `openTurn({ cause: { by: 'player', gesture } })`**, whose
> rendered snapshot and brief become the `TurnContext` handed to `TurnController.endTurn`. That is
> the whole of "voice intents route into `openTurn`": the player's turn takes the same path as a
> coaching turn, gets the widest `BRIEF_PLAN` row (`player_question`), and pre-empts rather than
> queues.

The last row of the table is the one rule that cannot be relaxed. **`agent_said.topics` is populated
from the `CoachEvent` that opened the turn, never from the transcript.** Nothing on this path
classifies natural language, which is what keeps the novelty gate deterministic and ADR-0013's
free-text prohibition structural rather than remembered — and it is why the composition root holds
the event from `openTurn` until the agent's final transcript arrives.

### 9.4 What the root does *not* do yet

It is constructed by injection and is not yet called from `apps/desktop/src/main/index.ts`, which is
still a skeleton with no Electron lifecycle in it — there is no `app.whenReady()`, no tray, no GSI
listener and no sidecar supervisor to hang it from. Wiring it to a running application is
REPO_SKELETON §10's remaining shell work, not this document's.

The consequence is stated plainly because it decides what a reader should expect: **every behaviour
in §9 is covered by a Tier 1 test against fakes, and none of it has run in an Electron process.**

---

## 10. Failure modes

The dota2 §9 table. Every row degrades loudly to the developer, quietly to the player, and never
silently into wrongness.

| Failure | Detected by | Response |
|---|---|---|
| A detector's input is missing | The detector | It emits nothing. Six of the eight can do this; §3.2's last column says which |
| A detector is unwired — no build target | Per-kind detection counters (§5.4) | A kind with zero detections in a whole match is visible. §3.3 |
| CV sidecar dead | No positions in the model | `enemy_missing`, `low_hp_no_escape` and `ult_ready` stop firing. Riki coaches on what GSI still gives |
| Triggers fire far more often than turns are spoken | The suppression counters | **Working as designed** until the ratio inverts. It is the primary tuning signal, not an error |
| Riki repeats advice on a topic | `already_advised` counter stays zero while a topic recurs | A bug, in the same class as `api_truncation`. The novelty gate reads the ledger, so it survives compaction |
| Riki says the same true thing forever | `latched` counter (§5.3) | The latch is what makes this impossible; a non-zero counter is it working |
| A trigger fires during a fight | `high_intensity` counter | Dropped. If the counter dominates, the intensity threshold is wrong, not the trigger |
| An admitted trigger renders an empty brief | `CoachingBrief.empty`, and `turn_closed: 'silent'` | Turn does not happen; the cooldown is consumed anyway (§5.6) |
| The player says "only when I ask" | The local parser, with no model in the loop | Gate 2 refuses everything. Must work with the model down |
| Match mode is Turbo / Ability Draft / custom | `meta.mode` | `not_in_match`. Riki is silent rather than confidently wrong about timings |
| Game paused | Game-clock ageing stops | Detectors that read the clock stop advancing; intensity does not manufacture calm (§7) |
| Two triggers on one version bump | The policy ranks | The lower one is dropped, not queued (§5.5) |
| Session lost mid-match | `packages/realtime` | This package keeps its latches and cooldowns: they are about the *match*, not the session |

---

## 11. Module boundaries

`coaching-architecture.md` §11's table, with this package's rows made real. Each "lint to add" lands
**with the code it constrains** and is proven by writing a violating file, running
`pnpm exec eslint` on it, watching it fail, and deleting it — including, for a cross-package rule,
adding the dependency so the import actually resolves (the `workspace` skill's first learning, and
its correction).

| Boundary | Rule | Held by |
|---|---|---|
| `events` → `world-model` | **Allowed.** Detection reads the reader | — |
| `events` → `context` | **Allowed, types only**: `CoachingMemoryReader`, `AdviceTopic`, `TapeEvent`, `EventId` | The one edge that already existed |
| `context` → `events` | **Forbidden**, in code and in spirit. `BRIEF_PLAN` stays on the context side | Existing `no-restricted-imports` |
| `events` → `realtime`, `gsi`, `log-tail` | **Forbidden** | `boundaries/element-types`, added here |
| `events` → `apps/*`, `electron` | **Forbidden** | `boundaries/element-types` and `boundaries/external`, added here |
| `events` → `node:fs`, `node:path` | **Forbidden**. This package does no I/O | `no-restricted-imports`, added here |
| `process.env` | Only `packages/config` | Existing rule |
| `console.*` | Only `packages/telemetry` | Existing rule |

The `events → realtime` rule is the one worth having. This package's whole job is to decide whether
to speak; a direct line to the thing that speaks would make the gates bypassable by anyone in a
hurry, and the decision would stop being a value that a test can inspect.

---

## 12. Claims to verify

House style: what has been read versus what has been measured. **None of the following has been
measured on this project**, and the first two are the same two `coaching-architecture.md` §12 names
as deciding whether the design is right.

| Claim | How to check | Consequence if wrong |
|---|---|---|
| **⚑ Proactive coaching at these thresholds is welcome rather than irritating** | A human playing a real match. Not a fixture | ⚑ The product bet. The mitigations are §5's conservative defaults and the `quiet-mode` off switch |
| **⚑ `kindWeight × magnitude × urgency × confidence × tendency` orders moments the way a coach would** | Replay corpus, ranked against human judgement | ⚑ The scoring function changes shape. `BRIEF_PLAN` does not |
| §4.5's weights, and every number in `config.ts` | The same replay corpus | One file changes. This is the design working |
| The latch is sufficient and no second de-duplication is needed | The `latched` counter over a full match, against a transcript | A repeat that no counter explains means the key is wrong, not the cooldown |
| Intensity from HP swing, proximity and cast rate actually tracks a teamfight | Replay a match and mark the fights by hand | The gate fires late or never; the inputs are dota2 §6.4's, not measured ones |
| `speakLatencySeconds` of 1.5 is the real floor | Time trigger → first audio on a live session | Window triggers arrive late, which is worse than not arriving |
| An escape-item list is a good enough proxy for "no escape" | Count `low_hp_no_escape` firings against deaths in a replay | The detector is noisy. §3.2 says the fix is the weight, not a cleverer detector |
| Per-hero `enemy_missing` with a group magnitude beats a group detection | Replay, and read the transcript | The topic granularity changes, which changes the novelty gate's behaviour |

---

## 13. Testing map

Tiers are REPO_SKELETON §5.3. Almost all of it is Tier 1 against fakes, with no game and no session
— which is the point of separating detection from scoring from gating in the first place.

| Unit | Tier | Asserts |
|---|---|---|
| Each detector | 1 | Fires on its condition, does **not** fire on its near-miss, and emits nothing when its input is absent |
| `salience` | 1 | The decomposition, and — named by `coaching-architecture.md` §13 — **a 0.55-confidence detection scores below the same detection from GSI** |
| Urgency | 1 | Zero past the deadline, monotone before it, and the speaking-latency subtraction |
| Each gate | 1 | Refuses on its condition and passes otherwise. Pure functions of a context, so no engine is needed |
| Gate order | 1 | A candidate refused by two gates is attributed to the earlier one (§5.2 rule 3) |
| Suppression accounting | 1 | Every refusal increments exactly one counter and emits exactly one `onSuppressed`; five identical refusals produce **one** ledger entry, not five (ADR-0024) |
| The latch | 1 | Speaking latches; the condition going false clears it; a persistent condition does not re-fire |
| Cooldown versus latch | 1 | The two are independent — the case §5.3 exists for |
| One trigger, one utterance | 1 | A second candidate on the same tick is dropped; a candidate during an open turn is dropped |
| `intensity` | 1 | Each of the three inputs alone can raise it; the window is game-time |
| `EventTape` | 1 | Records suppressed detections; top-`n` by salience, ordered newest last |
| `world-view` adapter | 1 | Envelope preserved through every projection; an unmapped path is `undefined`, never a guess |
| `intents` routing | 1 | Every row of §9.3's table, including that `agent_said.topics` comes from the event |
| The coaching turn | 1 | Trigger → `openTurn` with the topic → speech; empty brief → `closeTurn('silent')` and no speech |
| Trigger behaviour | 4 | Replayed 45-minute match: turns spoken, per-gate refusals, no repeated topic |
| Unprompted overlay path | 5 | A coaching turn shows `Speaking(unprompted)` and barge-in costs one key press |

The row that is easy to under-weight is **gate order**. It has no user-visible behaviour and it is
the thing §5.4's tuning signal is made of: a refusal attributed to the wrong gate sends whoever is
tuning to the wrong number.

---

## 14. Extensibility

What each change costs. If one of these is expensive, the boundaries are wrong.

**Add an advice topic** — one detector file in `detect/`, one arm on `CoachEventKind`, one weight in
`config.ts`, and one row in `BRIEF_PLAN` over in `packages/context`. Two packages, and no existing
module changes behaviour. This is the change that should happen most often and it is deliberately
the cheapest — the one genuinely good property the deleted tool registry had (coaching §14).

**Change what makes Riki speak** — `gates/`. Pure functions of a snapshot, a clock and
`CoachingMemoryReader`, which is what makes a threshold testable without a session.

**Change how much Riki speaks** — `config.ts`, alone. That is what §4.5 is for.

**Add a trigger *kind*** — a Phase or Quiet trigger (coaching §6.1) — is more than a detector,
because both need something the eight current kinds do not: a Quiet trigger reads
`CoachingMemoryReader.silentFor()` and needs its own gate for "the moment is safe", and both need a
`BRIEF_PLAN` row. Neither is required for the first coaching build and §15 keeps the Quiet trigger
open, as `coaching-architecture.md` §15 item 2 does.

**A topic that needs data the world model does not have** — a `packages/world-model` change (one
derived rule, state-capture §9), not a change here. If it seems to need a change to *fusion*, the
model is being asked to know it is feeding an LLM.

**A topic that needs something looked up mid-match** — the expensive one, deliberately. It means a
port, a deadline, a failure path and probably a watchdog, which is the machinery ADR-0023 removed.
The bar is that the deterministic version has to lose an argument first.

---

## 15. What this design does not decide

1. **Every coefficient in `config.ts`.** §4.5 gives the shape and the ordering; the numbers need a
   replay corpus and a person. `coaching-architecture.md` §16 step 8.
2. **Whether the Quiet trigger ships**, and on by default. Unchanged from `coaching-architecture.md`
   §15 item 2, and it is the trigger most likely to be loved or hated.
3. **`derived.threats` and `derived.pace*`.** §9.2 leaves them unsatisfied on purpose. They are
   `packages/world-model` derived rules — reachability from two positions and a movement speed, and
   farm against a benchmark — and until they exist the `threat` and `pace` brief sections render
   only what they can.
4. **Whether a trigger may request a fresh CV pass.** `CapturePort` survives with no consumer
   (coaching §5.3). Building it would reintroduce a deadline and a failure path into a component
   that has neither.
5. **Whether suppression counters reach telemetry as counters or as a sampled trace.** They are a
   value on the engine today, which is enough for a test and not enough for a tuning session.
6. **How `adviceTendency` is computed from durable memory.** §4.4 takes a function; ADR-0013 owns
   what fills it in, and it needs matches to exist before it means anything.

---

## 16. Build order

Both steps have landed. Recorded so the sequencing is inspectable and so the next person knows what
they can rely on.

1. ✅ **`packages/events`** — types, contracts, config, the eight detectors, salience, intensity, the
   thirteen gates, the tape and the engine, with the boundary lint added and proven (§11).
2. ✅ **The composition root** in `apps/desktop/src/main/agent/` — the world-view adapter, the
   `EventTapeReader` port, the coaching turn, and voice-intent routing into `openTurn` (§9).
3. **Tuning**, with a replay harness and a person. §12's first two rows, and every number in §15
   item 1. Last, because it is the only step that cannot be done against a fixture.

**What step 3 will find in place.** Every number it needs to move is in
`packages/events/src/config.ts`; every refusal it needs to read is in `EventEngine.counters()`; and
the corpus it needs is `fixtures/gsi/`, driven through `FakeGsiSource` into a real world model, a
real engine, and a real `ContextAssembler` — no session and no network, which is what makes tuning a
Tier 4 job rather than a live one.

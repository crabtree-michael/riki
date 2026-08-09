# Conversational architecture

**Status:** Design, approved 2026-08-09
**Supersedes in practice:** [coaching-architecture.md](coaching-architecture.md),
[coaching-trigger-architecture.md](coaching-trigger-architecture.md),
[llm-coach-architecture.md](llm-coach-architecture.md)
**Decision:** [ADR-0042](../adr/0042-riki-answers-questions-instead-of-deciding-when-to-speak.md)

Riki stops deciding when to speak. It answers when spoken to, and it answers by asking the world
model questions.

## 1. Why the product changed shape

The old design put the hard problem in the wrong place. Deciding *whether a coach should interrupt
you* is a judgement call, and the previous architecture answered it with 2,336 lines of machinery:
detectors proposing candidates, a salience score, an intensity fold, thirteen gates in a fixed
ladder, per-kind and global cooldowns, a novelty ledger. Then `packages/coach` asked a language model
the same question again, in prose:

> The overwhelmingly common correct answer is speak: false. A coach who comments on everything is
> uninstalled within one match.

Two mechanisms answering one question is one too many, and the code knew it — `coach.ts` justifies
the overlap as *"a cooldown is a guarantee and a paragraph is a tendency"*. That is a real
distinction, and it is not worth ten thousand lines.

The evidence that settled it came from a live match on 2026-08-09. In 152 world-model ticks, Riki
spoke once. Eighty-five candidates were refused by a single gate that had armed itself and could not
release, because the one event that clears it never arrived. Three of the four faults found that
morning were inside the machinery that exists to decide when to speak. The fourth was in the vision
sidecar.

A coach that never interrupts you cannot interrupt you wrongly. That removes the product's stated
worst failure mode by construction rather than by ladder.

## 2. What Riki is now

A voice assistant that watches the match with you and answers questions about it. You press the
hotkey, you ask, it answers. It has no opinion about when you should want to talk.

The value that remains is the value that was always underneath the coaching: **Riki can see the game
state and remember it, and you cannot.** You cannot check your net worth against theirs while
fighting, and you cannot remember where their position four was ninety seconds ago. Riki can.

## 3. The spine

```
GSI ─┐
log ─┼─► world model ─┬─► live state ─────────────► tools ─► Realtime session ─► voice
 cv ─┘                │
                      └─► match recorder ─► <matchId>.jsonl ─► timeline reader ─► world_at()
```

Everything upstream of `world model` is unchanged. Everything that used to sit between the world
model and the session — detectors, gates, salience, briefs, the coaching ledger — is deleted.

## 4. The tool surface

The model reaches the world through five named tools rather than one blob of pre-rendered text.
This inverts the old contract: the previous design assembled everything the model might need before
asking it to speak, because the trigger engine had already decided what the turn was about. With no
trigger, there is no topic to narrow to, and the model is the only thing that knows what it needs.

| Tool | Answers |
| --- | --- |
| `my_state()` | Hero, level, hp/mp, gold, buyback, items, abilities and cooldowns |
| `enemy(hero?)` | Last known position and its age, items seen, level estimate. Omit the argument for all five, summarised |
| `objectives()` | Towers and racks standing, Roshan, rune windows, day/night |
| `economy()` | Net worth both sides, gpm/xpm, lane equity |
| `world_at(clock, topic?)` | Any of the above, as it stood at a past moment |

Narrow tools rather than one `get_world(topic)` or a generic `query(path)`, for a reason specific to
voice: a failed call is not a retry, it is a pause in a spoken sentence. A generic path query invites
the model to invent `enemy.puck.last_seen_position` and discover it does not exist mid-answer. Five
named tools with typed arguments make the knowable surface legible from the tool definitions alone.

This reverses [ADR-0023](../adr/0023-coaching-replaces-command-execution.md), which sent `tools: []` on the grounds
that *"the facts a turn needs are assembled before the model is asked to speak"*. That reasoning was
correct while a trigger engine chose the topic. It does not survive the trigger engine.

## 5. Every answer is a Fact

No tool returns a bare value. Every field carries what is needed to judge it:

```json
{ "value": 1868, "age_seconds": 0.4, "confidence": 1.0, "source": "gsi" }
{ "value": "bottom rune", "age_seconds": 34, "confidence": 0.55, "source": "cv" }
{ "unknown": "never observed this match" }
```

This is not new machinery. `Fact<T>` is already the world model's central type and its header
already states the stake:

> A pipeline that flattens a 0.55-confidence minimap blob and a GSI health value into the same
> `number` has discarded the only thing that stops Riki confidently getting someone killed.

The tool layer's entire correctness obligation is to not lose that on the way out. Two consequences
are load-bearing:

1. **`unknown` is a first-class return.** GSI gives Riki its own team live; everything about the
   enemy is inference from vision and the console log. A tool that cannot distinguish "zero" from
   "never seen" is a tool that will state a guess as a fact.
2. **Age travels with the value, never separately.** Age is computed at read time from `observedAt`,
   because a stored age is already wrong by the time anyone reads it.

The system prompt's job shrinks to two rules: call a tool before answering a question about the
match, and never state an aged value as current.

## 6. The match dataset

A match is recorded to disk as it plays, and the recording is the agent's memory.

**Format.** Timestamped JSONL, the format `tools/gsi-record` already produces, at
`Application Support/Riki/matches/<matchId>.jsonl`. Every observation is appended with its
timestamps; a full keyframe — a serialised `WorldState` — is written every 30 seconds.

**Reading it back.** `world_at(t)` seeks the nearest keyframe at or before `t` and replays
observations forward to the instant. Bounded work per query, and flat in match length. This is what
`tools/gsi-replay` already does, pointed at a different question.

> **Amended by [ADR-0048](../adr/0048-world-at-takes-a-clock-or-an-offset-and-they-are-different-axes.md):**
> the bound is the *delta-history window* (5½ minutes, ~2,600 fusions, a few milliseconds) and not
> the 30-second keyframe interval this paragraph assumed. A keyframe does not carry the delta ring,
> and `objectives.recently_lost` is recovered from it — so a 30-second replay would report an empty
> array meaning "nothing has fallen". The property being protected here, a constant cost independent
> of match length, is intact; the constant is larger.

**Why disk rather than memory.** Three things fall out of it that memory does not give:

- A recorded match is a test fixture. The repo's fixtures are already this format, so every match
  played becomes a replayable case — and the absence of one is what made 2026-08-09's debugging take
  a morning.
- Match memory survives a crash. The old design lost the match's memory with the process.
- The 5-minute bound in `history/ring.ts` disappears for historical questions. The ring stays for the
  live path, where its bound is appropriate.

**Privacy.** [REPO_SKELETON §7.2](../../REPO_SKELETON.md) requires privacy toggles to ship off, and
dota2 §7 requires the Steam ID hashed before any egress. The recording is **local-only and never
transmitted**; the hash rule applies to the file as well, on the principle that a local file is one
upload away from being egress. Retention is bounded: keep the last N matches, prune oldest on match
start. N is configurable and defaults to 20 — roughly 200 MB at the upper size estimate.

**Size.** At ~1 Hz for 45 minutes, 3–10 MB of observations plus ~2 MB of keyframes per match.

## 7. What is deleted

| Package | Lines | Fate |
| --- | --- | --- |
| `packages/events` | 2,336 | Deleted entirely |
| `packages/coach` | 1,967 | Deleted. The Realtime model is the only model now |
| `packages/context` | 7,069 | Brief assembly, coaching memory, the conversation ledger and the preamble deleted. The snapshot renderer survives, repurposed as the tool response renderer |

Also deleted: the trigger pump, `setQuietMode`/`setAgentSpeaking`/`setPlayerSpeaking`/`setMuted` as
engine switches, the gate-state and trigger panels in the inspector, and the unprompted entry path in
the interaction machine.

`agent_speaking` deserves a specific note, because deleting it looks like deleting a safety property.
It existed to stop a coaching trigger landing on top of a turn already speaking. With no triggers,
nothing can land on anything: every turn has a key press behind it, and barge-in is already handled
in `packages/realtime` by truncation. The gate was solving a problem the trigger engine created.

## 8. What survives

`gsi`, `log-tail`, `world-model` (grows), `realtime`, `audio`, `protocol`, `config`, the overlay chip
and its interaction machine, the vision sidecar, the inspector (with different panels).

The interaction machine keeps `armed → listening → processing → speaking` and loses only its
unprompted entry. `listen-timeout` stays and so does "Didn't catch that" — a question nobody finished
asking is still a real state.

## 9. Testing

The tool layer is pure functions over `WorldState`. No network, no API key, no GPU, no game — which
is [REPO_SKELETON §7.1](../../REPO_SKELETON.md)'s rule, met without effort for the first time in the
part of the system that matters most.

Three tiers:

1. **Tool unit tests.** A `WorldState` in, a tool result out. Assert the `Fact` envelope survives,
   assert `unknown` where nothing was observed.
2. **Timeline tests.** Record a fixture, read it back at N instants, assert `world_at` reconstructs
   what the live store held at that version.
3. **Replay tests.** Drive a recorded match through the whole chain with a fake session, assert the
   tools answer plausibly at chosen moments.

## 10. Known risks

**Tool latency lands mid-answer.** A round trip inside a spoken response is audible in a way it is
not in text. Mitigations, in order of preference: keep returns small; consider pre-injecting a short
vitals block at turn start so trivial questions need no call; measure before optimising.

**The model may answer without calling a tool.** It has a plausible-sounding match in its context
from earlier turns and no hard incentive to refresh. The prompt must make the call mandatory for any
factual claim, and the inspector must show every turn's tool calls so a skipped call is visible
rather than inferred from a wrong answer.

**`world_at` invites questions the data cannot answer.** "Where was their mid at 12:00" is answerable
only if something observed it. The `unknown` return is the whole defence, and it needs to be as
easy for the model to say as a number is.

## 11. Open questions

1. Does `enemy()` with no argument return five summaries or refuse and ask which hero? Five
   summaries is more useful and more tokens.
2. ~~Should `world_at` accept a wall-clock offset ("thirty seconds ago") as well as a game clock?
   Players speak in both.~~ **Settled by [ADR-0048](../adr/0048-world-at-takes-a-clock-or-an-offset-and-they-are-different-axes.md):**
   yes, as `seconds_ago`, and it seeks on the wall axis rather than being converted to a clock —
   the two differ during a pause, and only the wall axis exists at all during the draft.
3. Does the vitals pre-injection in §10 belong in v1, or is it premature before latency is measured?

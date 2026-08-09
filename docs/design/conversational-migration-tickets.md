# Conversational migration — tickets

Execution plan for [conversational-architecture.md](conversational-architecture.md) /
[ADR-0042](../adr/0042-riki-answers-questions-instead-of-deciding-when-to-speak.md).

Written to be dispatched to independent agents. Every ticket names the files it owns so two agents
do not meet in the same file. **Waves are strict**: everything in a wave may run in parallel;
nothing in a wave starts before the previous wave has merged.

Every ticket inherits the repo's standing rules: read `AGENTS.md` and `REPO_SKELETON.md` first,
write the failing test before the fix, `console.*` stays confined to `packages/telemetry`, no test
may require a game, GPU, network or API key, and `pnpm check` must pass. Note that the cargo legs
skip silently on a machine with no Rust toolchain — green there does not mean the Rust side built.

---

## Wave 0 — clear the decks

### T0. Land the three in-flight fixes and resolve the ADR collision

**Why.** Three branches from 2026-08-09 are finished and unmerged, and two of them claim the same
ADR number.

**Scope.** Branches `fix/vision-cg-init`, `fix/realtime-cancel-guard`, `fix/gate4-turn-watchdog`.

**Do.**

- Merge `fix/vision-cg-init` (ADR-0040) and `fix/realtime-cancel-guard` first — neither is affected
  by the migration.
- **Renumber the gate-4 branch's ADR to 0041.** Both it and the vision branch wrote
  `docs/adr/0040-*.md`; whichever merges second must move.
- Merge `fix/gate4-turn-watchdog` knowing **half of it is superseded by T1**: the coaching-turn
  watchdog dies with `packages/events`, but the `beginPlayerTurn` half stays and is the half that
  still matters. Do not skip the merge to save the deletion — the test coverage documents the
  hazard.

**Done when.** All three merged on `main`, ADR numbers unique, `pnpm check` green.

---

## Wave 1 — the deletion

### T1. Delete the trigger engine and simplify the composition root

**Why.** Everything else is easier against a smaller tree, and this ticket alone touches
`shell/index.ts`. Running it first means no later ticket has to merge against a moving composition
root.

**Scope — owns.** `packages/events/` (delete), `packages/coach/` (delete), `packages/context/`
(prune), `apps/desktop/src/main/shell/index.ts`, `apps/desktop/src/main/agent/`,
`apps/desktop/src/main/session/machine.ts`, `apps/desktop/src/main/tray/`, the gate and trigger
panels under `apps/desktop/src/{main,renderer,shared}/debug*`.

**Do.**

- Delete `packages/events` and `packages/coach` outright.
- Prune `packages/context` to the snapshot renderer and reference data. Brief assembly, coaching
  memory, the conversation ledger and the preamble go.
- Remove the trigger pump, the four engine switches (`setQuietMode`, `setAgentSpeaking`,
  `setPlayerSpeaking`, `setMuted`), and the coach-mode tray row.
- Remove the unprompted entry path from the interaction machine. Keep `armed → listening →
  processing → speaking`, keep `listen-timeout` and keep "Didn't catch that" — an unfinished question
  is still a real state.
- Keep `endPlayerTurn`'s existing snapshot injection. **After this ticket Riki must still work**: press
  the key, ask a question, get an answer with the current snapshot injected. That working state is
  the acceptance criterion, not a bonus.
- Mark `coaching-trigger-architecture.md` and `llm-coach-architecture.md` superseded. Do not delete
  them; their reasoning about staleness feeds T8.

**Done when.** The app boots, a player question is answered end to end against a real session, no
reference to `@riki/events` or `@riki/coach` remains, and `pnpm check` is green.

**Watch for.** `apps/desktop/src/main/debug/` observes the engine by decoration (ADR-0032). Removing
the observed thing must not leave the decorator half-wired.

---

## Wave 2 — foundations

### T2. Tool schemas and registry

**Why.** T3 and T4 both need the types; neither should invent them.

**Scope — owns.** `packages/protocol/src/schemas/tools.ts` (new), `packages/realtime/src/tools.ts`
(new).

**Do.** Define the five tool signatures and their return types, and the `Fact` envelope as it crosses
to the model: `{ value, age_seconds, confidence, source }` or `{ unknown: reason }`. Zod schemas,
codegen-clean. No implementation — types and validation only.

**Done when.** Schemas exist, `pnpm codegen:check` passes, and a round-trip test proves an `unknown`
cannot be silently coerced to a value.

### T5. Match recorder

**Why.** The dataset the agent's memory is built on.

**Scope — owns.** `packages/world-model/src/record/` (new), `apps/desktop/src/main/state/` wiring.

**Do.** Append every observation with its timestamps to
`Application Support/Riki/matches/<matchId>.jsonl`, in the format `tools/gsi-record` already
produces. Write a full serialised `WorldState` keyframe every 30 s. Open on `match_started`, flush
and close on `match_ended`, and survive a crash mid-match with a readable partial file.

**Done when.** A replayed fixture produces a file that `tools/gsi-replay` can consume, and a killed
process leaves a file that still parses to the last complete line.

### T7. Realtime session renewal

**Why.** Observed live on 2026-08-09 at 15:43:36: `session_expired — "Your session hit the maximum
duration of 60 minutes."` The data channel closed, ICE disconnected, and nothing reconnected. Dota
matches routinely pass an hour.

**Scope — owns.** `packages/realtime/src/session.ts`, `credentials.ts`,
`apps/desktop/src/main/voice/session.ts`.

**Do.** Detect the expiry — both the error code and the transport close — and reopen transparently:
mint a new client secret, renegotiate, resend `session.update`. Decide and document what carries
across the boundary; the conversation history does not survive a new session, so the reopened session
starts cold and the player must not be told twice. Renew *before* the cap where possible rather than
reacting to the error.

**Done when.** A test drives an expiry against a fake transport and asserts a new session is open
with no player-visible fault, and the inspector shows the renewal.

**Watch for.** `faultFor` classification interacts with this — coordinate with what
`fix/realtime-cancel-guard` landed in T0.

### T9. Inspector: replace gate panels with a tool trace

**Why.** The inspector's centre of gravity was the gate ladder, which no longer exists. Its
replacement is the thing that will actually need watching: which tools the model called, with what
arguments, and what came back.

**Scope — owns.** `apps/desktop/src/renderer/debug/`, `apps/desktop/src/shared/debug.ts`,
`apps/desktop/src/main/debug/`.

**Do.** Per turn: the question, the tool calls with arguments and results, the answer, and the
latency of each leg. A turn that answered a factual question with **no** tool call must be visibly
flagged — that is the failure mode §10 of the design names.

**Done when.** A replayed turn renders its full call trace, and a no-call turn is visually distinct.

---

## Wave 3 — the tools themselves

### T3. Tool implementations

**Depends on.** T2.

**Scope — owns.** `packages/world-model/src/tools/` (new).

**Do.** Implement `my_state`, `enemy`, `objectives`, `economy` as pure functions from `WorldState` to
the T2 return types. Preserve the `Fact` envelope on every field. Return `unknown` — never zero,
never a default — where nothing was observed.

**Done when.** Unit tests over fixture states cover each tool, including at least one assertion per
tool that an unobserved field returns `unknown` rather than a plausible number.

**Open question to settle in this ticket.** `enemy()` with no argument: five summaries, or refuse and
ask which hero? Five is more useful and more tokens. Decide, and write down why.

### T6. Timeline reader and `world_at`

**Depends on.** T2, T5.

**Scope — owns.** `packages/world-model/src/timeline/` (new).

**Do.** Seek the nearest keyframe at or before `t`, replay observations forward to the instant, return
the same shapes as T3's tools. Bounded work per query — never more than one keyframe interval of
replay.

**Done when.** Reading a recorded fixture at N instants reconstructs exactly what the live store held
at those versions, asserted field by field.

**Open question to settle in this ticket.** Should `world_at` accept "thirty seconds ago" as well as a
game clock? Players speak in both.

### T4. Wire tool calling into the session

**Depends on.** T2.

**Scope — owns.** `packages/realtime/src/session.ts` tool-call handling, `turn.ts`.

**Do.** Send the tool definitions in `session.update` — this reverses `tools: []` from ADR-0023.
Handle `response.function_call_arguments.done`, dispatch, and return `function_call_output`. Note
that `session.ts` currently treats a tool call as a model error and counts it as `strayToolCall`;
that branch inverts.

**Done when.** A fake session drives a full call round trip, and a tool that throws produces a
degraded answer rather than a dead turn.

---

## Wave 4 — finish

### T8. Rewrite the system prompt

**Depends on.** T2, T4.

**Scope — owns.** the prompt module surviving T1's prune.

**Do.** Two hard rules: call a tool before any factual claim about the match, and never state an aged
value as current. Lift the staleness reasoning from the old coach prompt — *"say 'was bottom thirty
seconds ago', not 'is bottom'"* — which is the one part of the deleted machinery worth keeping
verbatim. Drop everything about whether to speak.

**Done when.** A replayed set of questions produces answers that cite ages, and refusals where the
data is `unknown`.

### T10. Retention and privacy

**Depends on.** T5.

**Scope — owns.** `packages/config`, the recorder's prune path.

**Do.** Keep the last N matches (default 20), prune oldest on match start. Hash the Steam ID in the
file per dota2 §7. Document local-only and never-transmitted. Add the config key alongside the
existing privacy toggles and honour §7.2 — anything that widens what is retained ships off.

**Done when.** A test proves pruning at the boundary and that no unhashed Steam ID reaches disk.

### T11. Replay end-to-end harness

**Depends on.** T3, T4, T6.

**Scope — owns.** `apps/desktop/test/`, `tools/`.

**Do.** Drive a recorded match through the whole chain with a fake session: ask scripted questions at
chosen moments, assert the tools are called and the answers are grounded. This is the regression net
that did not exist on 2026-08-09.

**Done when.** One recorded match runs green in CI with no network, no key and no game.

---

## Sequencing at a glance

| Wave | Tickets | Can run in parallel |
| --- | --- | --- |
| 0 | T0 | — |
| 1 | T1 | — |
| 2 | T2, T5, T7, T9 | yes |
| 3 | T3, T6, T4 | yes (T6 needs T5) |
| 4 | T8, T10, T11 | yes |

The two solo waves are solo for one reason each: T0 resolves a numbering collision that a parallel
merge would make worse, and T1 owns `shell/index.ts`, which nearly everything else also touches.

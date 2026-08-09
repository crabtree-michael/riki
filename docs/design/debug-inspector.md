# The inspector — a live view of what Riki believes, and a way to argue with it

> ## ⚠ Partly superseded
>
> **[ADR-0042](../adr/0042-riki-answers-questions-instead-of-deciding-when-to-speak.md), 2026-08-09**
> deleted the trigger engine, and with it the five panels that were this window's centre of gravity:
> **Triggers, Gate state, Counters, Controls and Rehearsal**. Every one observed something that no
> longer exists, so all five are gone rather than empty — a panel rendering "0 of 13 gates" against
> no engine is worse than an absent one. ADR-0037 and ADR-0038 are superseded with them.
>
> **What is current:** §2 and §2.1 (rewritten for the tool trace), §2.3, §3 and §4 — the decoration
> rule, the push/pull split, the frame's bounds and the "costs nothing when off" property — which
> are why every surviving panel needed no hook in any package. ADR-0039's scenarios are now the
> window's only write surface.
>
> **What is history:** §2.2 (both coaches) and §2.5 (the rehearsal panel) describe machinery that no
> longer exists, and are kept only because §2.5's argument about marking a fabricated turn is the
> argument [ADR-0047](../adr/0047-a-turn-is-its-tool-calls.md) reuses. §1's problem statement is
> about the trigger ladder and is worth reading as the shape of the *new* problem rather than the
> old one: the failure it describes — a system whose working and broken states look identical — is
> exactly the failure the tool trace exists to make visible.

**Status:** Built. `apps/desktop/src/main/debug/`, `src/preload/debug.ts`,
`src/renderer/debug/`, off by default behind `config.debug.enabled`.
**Scope:** A dev-only window showing what Riki believes, what it was given for a turn, which tools
it called to answer, and what it said.
**Out of scope:** Telemetry sinks and log redaction (`packages/telemetry`, still a skeleton); the
player-facing settings surface (`src/renderer/settings/`).

---

## 1. The problem

Riki decides, several times a second, whether to say something. That decision runs eight detectors
over a fused world model, scores what they produce, ranks it, and asks thirteen gates about the
winner. The overwhelmingly common outcome is silence — by design; dota2 §6.4's closing line is that
*"unprompted speech is the feature most likely to make Riki annoying enough to uninstall"*, so the
whole system is built to fail quiet.

Which means the normal appearance of a working Riki and the normal appearance of a broken one are
**identical**. Before this window, the ways to tell them apart were:

| Available | What it answers | What it cannot answer |
|---|---|---|
| `fixtures/golden/` | Does the snapshot/brief renderer still produce the right text *for six moments somebody wrote down*? | Anything about a running session |
| `TriggerCounters` | How many detections and how many refusals, per kind and per reason, for a whole match | Which candidate, at which moment, for which reason |
| `EventEngine.onSuppressed` | The winner's first refusing gate, one event at a time | The losing candidates; the other twelve verdicts; the state behind them |
| `ShellTelemetry` | — | Nothing: `packages/telemetry` is a skeleton, so every call goes to `nullTelemetry()` |
| `console.log` | — | Nothing: `console.*` is confined to `packages/telemetry` by lint |

The last row is the sharpest. The rule that confines logging is right — it is what keeps redaction
unbypassable — but its consequence today is that **the shell has no way to emit a line at all**. A
sidecar panic, a renderer fault, a source that gave up, a world-model reset: all of them are
reported, and all of them reach `nullTelemetry()`.

## 2. What it shows

Two columns, one document, redrawn whole at 4 Hz — without moving the reader (§2.3).

| Panel | Answers |
|---|---|
| **Scenarios** | The runnable scenarios, and how the last run of each ended (ADR-0039) |
| **World model** | Every observed `meta.*`, `self.*` and `map.*` leaf with its full envelope — value, source, confidence, staleness, age, and age *basis* |
| **Enemies / Derived** | Per-hero position or last-seen with staleness; every derived rule's answer, with `null` shown as *declined* rather than as zero |
| **Turns** | Per turn: the snapshot exactly as rendered, which sections were omitted, **every tool call with its arguments, result, status and duration**, the latency of each leg, the outcome, and what Riki said — §2.1 |
| **Trace** | The turn chain in order, and where it stopped (ADR-0039) |
| **Sources** | Bus depth, drops, `seq` gaps, and each source's liveness |
| **Problems** | Everything `ShellTelemetry` reports as a fault, which currently reaches nowhere else |

### 2.1 The tool trace is the point

ADR-0042 replaced a pre-assembled brief with five tools, which moves the interesting half of a turn
out of the snapshot and into calls the session makes mid-answer. Those calls are composed, sent and
forgotten; **nothing in the process records that one happened**, and there is no counter, no log
line and no fixture that can say afterwards whether the model asked the world anything before it
spoke.

That matters because of the risk [conversational-architecture.md §10](conversational-architecture.md)
names:

> **The model may answer without calling a tool.** It has a plausible-sounding match in its context
> from earlier turns and no hard incentive to refresh.

This is the gate ladder's failure mode wearing new clothes, and it needs the same treatment for the
same reason: it is **silent**. A turn answered from a fact observed four hundred milliseconds ago
and a turn answered from pretraining produce the same audio, the same transcript and the same
outcome, and differ only in whether they were right.

So a turn shows its calls, and a turn that spoke without making one is marked — a tinted head row
and a red pill, findable while scrolling past without reading a word. Four things about how, all
argued in [ADR-0047](../adr/0047-a-turn-is-its-tool-calls.md):

- **The mark is wider than the failure, on purpose.** §10's failure is a *factual* question answered
  with no call, and this window cannot detect that one because it never sees the question (§6). So
  every spoken turn with no calls is marked, "say that again" included. A false positive costs a
  reader two seconds; a false negative is an ungrounded answer nobody catches by listening.
- **`unknown` is a status of its own**, beside `ok`, `refused` and `failed`. A tool answering
  honestly that nothing was observed (ADR-0043) is not a fault, but it is the answer to *why was
  that answer so vague*, which no other status expresses.
- **A call is recorded before it is dispatched**, so a dispatcher that hangs shows as a `pending`
  row rather than as nothing at all. A wedge that renders as an absence is how 2026-08-09's gate 4
  stayed invisible for a whole match.
- **The legs are the ones that can be measured**: to the first call, through the calls, to the
  answer. There is no leg for the model's own deliberation, because the gap before the first call
  contains a round trip, a read and a decision, and nothing here can separate them.

### 2.2 Both coaches — history

> Both coaches are deleted (ADR-0042). Kept because the seam argument in the last paragraph is the
> one §3 still runs on: cover a new producer by decorating something the composition root already
> injects, and change nothing in the package that produces it.

ADR-0031 added a second coach: `packages/coach` asks a model *should Riki speak right now* instead
of running detectors through a gate ladder. The inspector covers both, and covering the second one
required no change to `packages/coach`, to `agent/driver.ts`, or to the shape of a frame.

| | `static` | `llm` |
|---|---|---|
| Triggers panel | candidates, salience, and all thirteen gates per candidate | one row per decision, with the model's own sentence |
| Gate state | the engine's latches, cooldowns and intensity | empty — `packages/events` is not running |
| Counters | `TriggerCounters`, per kind and per reason | empty, for the same reason |
| Coach turns | the snapshot and brief as rendered | identical — both coaches open turns through the same assembler |
| Problems | — | `coachUnavailable`, `modelFailed` |

Two seams do it. `observeContext` wraps the assembler, which **both** coaches and the push-to-talk
path open turns through, so the rendered snapshot and brief are readable whichever is running.
And `packages/coach` already reports `declined`, `skipped`, `coachUnavailable` and `modelFailed` to
`CoachTelemetry`, which `ShellTelemetry` extends and the shell hands to both coaches — so the
telemetry decorator was already in the right place.

`DebugSession.coachMode` is in the header for a reason: under `llm` an empty Gate state panel and an
empty Counters panel are *correct*, and without the label they read as a broken inspector.

### 2.3 Reading it while it updates

Redrawn whole means the document is thrown away four times a second, and the first version of this
threw the reader's position away with it: scrolling up to study a gate ladder lasted 250 ms before
the next frame returned you to the top. That made the window unreadable during the only time it is
worth reading — while a match is running. ADR-0036 is the fix and it is two rules.

**The two scrolling columns and the header's button are never rebuilt**, only refilled.
`scrollTop` belongs to the element, so a column recreated each frame has no position to preserve;
and a `<button>` recreated each frame takes keyboard focus to `<body>` with it. Everything inside a
column is still rebuilt whole — the property that keeps a stale node from surviving a redraw is
untouched. The scenario buttons live *inside* a column and are therefore rebuilt, so `app.ts`
restores keyboard focus by the `data-focus` key each of them carries — the focus counterpart of what
`scroll.ts` does for position, and the reason tabbing to a scenario works at all. That restore
passes `preventScroll: true`, because otherwise the two halves fight: `focus()` scrolls its element
into view inside the column `scroll.ts` has just restored, and a focused button is in the topmost
panel. Touching a control and then scrolling down to watch what it did was the reported bug, and it
looked exactly like the one above.

**Position is content, not a number.** The panels that grow render newest-first, so a new tick is
prepended and every pixel offset below it is wrong the moment it lands. `renderer/debug/scroll.ts`
notes the topmost row on screen by the `data-ins-key` `view.ts` stamps on it — a `seq`, a `turnId`,
a fact path, never a render index — and puts that row back at the same height afterwards. The two
edges are pinned instead: at the top means *follow the newest*, which newest-first is where new rows
appear, and at the bottom means *keep the oldest row still* as the buffer grows above it.

Freeze is still worth having and is now about the values rather than the scrollbar: text selection
does not survive a redraw, and a gate ladder read live is read while it is replaced.

### 2.5 Asking a question, not just reading the answer — history

> The Rehearsal panel is deleted with the coaches it rehearsed (ADR-0042); ADR-0039's scenarios are
> what remains of the idea. Kept for the paragraph beginning *"A rehearsed turn is marked"*, whose
> rule the tool trace inherits: **mark a turn wherever it could be mistaken for something it is
> not.** That is why a `system` cause still draws its own pill, and why a turn with no tool calls is
> marked rather than left to be inferred from an empty list (ADR-0047).

ADR-0037 made the numbers movable and left the cost of a reading where it was: seeing what the coach
does with laning phase still meant reaching laning phase. **ADR-0038's Rehearsal panel** replaces
that with a button. Pick a mock game state, click, and one coach turn runs against it — the drafted
line lands in Coach turns, the gate ladder in Triggers, and neither took a match to produce.

What makes an *action* intent acceptable where ADR-0037 explicitly refused one is that a rehearsal
reaches none of the live match. It builds a scratch world, a scratch context and a scratch coach,
runs one consultation and disposes all three: the facts the app is coaching on never see a mock
payload, the latch set and cooldown clocks in the Gate state panel do not move, and **no
`CoachingSessionPort` is reachable from `rehearsal.ts` at all** — so it cannot make Riki speak. That
last one is enforced by there being no path, not by a flag.

A rehearsed turn is marked wherever it could be mistaken for a real one: `mockState` carries the
state's id and draws a `mock:` pill, the outcome closes `rehearsed` or `declined` and never `spoke`,
and the ids come from their own `rehearsal_N` counter so they cannot collide with the coach's. The
window's whole job is to be believed, and offering a fabricated moment and a played one as the same
claim is the one way it could stop being.

Two things it is honest about rather than hiding. The states are `fixtures/gsi/*.jsonl` — the corpus
`shell.test.ts` already replays — so **a mock state is a timeline, not a moment**: what the coach
reads is what the whole file fuses to. And the recording is *slid* onto main's clock rather than
replayed at its recorded times, because a fixture's `atMs` starts at zero and applying it literally
would age every fact to `expired` and render as an empty match.

The dropdown is a disclosure built from buttons, for the reason every control is a button: a native
`<select>`'s popup would be destroyed by the next redraw, 250 ms later.

## 3. Shape

```
   SnapshotSource ───decorated────►┐
   ToolDispatcher ───decorated────►│
   ShellTelemetry ───decorated────►├──► DebugHub ──frame(now)──► DebugWindow ──IPC──► renderer/debug
   VoiceSessionPort ─subscribed───►│         ▲
   world / health / actions ───────┘         └─ pulled at frame time, not pushed
```

Every seam is a thing the composition root already injects, so `packages/context`,
`packages/realtime` and `packages/world-model` are **unchanged by this component**. That is not
tidiness — it is the reason the inspector can be trusted, because there is no version of the turn
path that only runs when somebody is watching.

### 3.1 Push for edges, pull for state

Turns, tool calls, problems and trace steps are pushed: they are events, they happen whether or not
the window is open, and missing one is missing the thing you opened it to see. Turns therefore
accumulate from the moment the hub exists — the most useful moment to open an inspector is just
*after* something looked wrong.

The world model, the session, health and the action list are pulled when a frame is built. They are
current-value questions, and pushing them would mean building a projection several times a second
into a buffer nobody reads.

### 3.2 Why the snapshot source is the seam for turn text

`SnapshotSource.render` produces the text a turn is answered from; the agent composes it into one
system message and forgets it, and `fixtures/golden/` only shows what the renderer produces for a
*fixture*. So the one rendering that matters — the one Riki was about to answer on the strength of —
has nowhere else to be read.

A decorator rather than a hook on the agent, because the debug window's own `scenario.speak` renders
a snapshot without going through the agent at all, and a hook there would miss it. The shell
constructs one `SnapshotSource` and injects it into both.

### 3.3 Why the dispatcher is the seam for tool calls

The same argument one layer along, and the reason §2.1 is possible at all. A tool call is dispatched
inside `packages/realtime`'s turn handling and its output is sent and dropped; decorating the
`ToolDispatcher` the composition root injects sees every call, its arguments, its answer and its
duration, without `packages/realtime` or `packages/world-model` knowing a window exists.

One thing it structurally cannot see, and the reason `DebugHub.recordToolCall` is public beside it:
a call refused before dispatch — a tool name that is not one of the five, or arguments the schema
rejects — never reaches a dispatcher. That is the model getting the tool surface wrong, which is the
most interesting thing it can do, so it is recorded through the hub directly and carries the
`refused` status (ADR-0047).

## 4. What it can and cannot change

### 4.1 It changes nothing on its own

The load-bearing property, and each part of it is enforced somewhere:

| Claim | Enforced by |
|---|---|
| The snapshot decorator returns the renderer's own text | `observing-snapshot.test.ts` |
| The dispatch decorator returns the dispatcher's own answer, and re-throws its errors | `observing-dispatch.test.ts` asserts object *identity*, not deep equality — and that a rejection still rejects, because `packages/realtime` turns a failed call into a degraded answer rather than a dead turn |
| The telemetry decorator never swallows an event | `telemetry.test.ts` walks every member of `ShellTelemetry` reflectively, keyed off `nullTelemetry()`, and asserts each one reached the delegate — so an arm that mirrors a fault but drops its `delegate.` line fails, and a member added later is covered the day it compiles |
| An untouched inspector is inert end to end | `shell.test.ts` replays `fixtures/gsi/laning-phase.jsonl` twice, with the flag off and on, and asserts the same utterances come out |

The last is the test worth having. A debug tool that perturbs the turn path *by existing* is worse
than no debug tool, and the decorator on the dispatcher is the easiest place in the codebase to
break that: it sits on the path a spoken answer runs through, and one swallowed rejection turns a
failed tool into silence.

### 4.2 …and when it does, it is one row of a registry — history

> Every control described below is deleted: the registry was `packages/events`' thresholds, gates
> and detectors, and ADR-0042 deleted all three. ADR-0039's scenarios are the window's only write
> surface now, and the *reachable set is a registry, not a surface* rule at the end of §5.1 is what
> survives of this section.

ADR-0037. The window was read-only, which was right for §4.1 and wrong for the question it kept
producing: *`ult_ready` scored 0.281 and `speakThreshold` is 0.3; what happens at 0.25?* The only
answer used to be to edit `packages/events/src/config.ts` and replay the match — during which the
latch set, the cooldowns and the intensity fold all start from nothing, so the moment being
investigated is gone before the number matters.

The mechanism is §3's, pointed one step further. `TriggerConfig`, `Gate[]` and `EventDetector[]` are
things the composition root already injects, so the inspector changes behaviour by **choosing what to
inject** rather than by getting a handle on the engine:

| Injected | What the live version is |
|---|---|
| `createEventEngine({ config })` | A getter-backed `TriggerConfig`: every read consults an override map and falls through to the default |
| `createTriggerPolicy(gates)` | Thirteen wrappers over `GATES`, each of which delegates unless its switch is off |
| `createEventEngine({ detectors })` | Eight wrappers over `DETECTORS`, each of which returns nothing when its switch is off |

All three are **stable objects whose answers change**, because `createEventEngine` reads its
collaborators once at construction. Rebuilding the driver per click would work and would discard the
latch set and the cooldown clocks — which are the state somebody is watching while they turn the
knob.

`packages/events` is unchanged by this, exactly as it was by §3.

**What is reachable.** Every number in `packages/events/src/config.ts` — twenty-one scalars, eight
kind weights, eight kind cooldowns — plus each detector and each gate as an on/off, plus `coach.mode`
and unprompted speech. The registry is derived from `TriggerConfig`, `COACH_EVENT_KINDS` and `GATES`,
as a `Record` total over the numeric keys, so **a number added to `config.ts` fails the build until it
has a range** and then appears in the window with no renderer change.

**What is not, and why it is shown rather than hidden.** A locked control is rendered with its reason
attached, because "why can I not turn off the `muted` gate" is a question the window should answer
where it is asked — a control that is simply absent invites somebody to add it.

| Locked | Reason |
|---|---|
| `gate.quiet_mode`, `gate.muted` | The player's own instruction. The inspector may make Riki quieter freely and louder only within what the player allowed |
| Mute itself — not a control at all | One producer, the menu row (ADR-0028) |
| `blockedModes`, `escapeItems` | List-valued; a stepper cannot edit them |
| `debug.enabled`, the key, ports, paths, the hotkey | Not the judge's behaviour, and the first would let the window switch itself off |

**A switched-off gate is still evaluated and still drawn.** Turning `kind_cooldown` off and watching
it go on lighting up against the candidate that now speaks is the point — the grid stays thirteen
rows long, so *"if I put this back, that one dies again"* is readable rather than inferred.

### 4.3 Nothing is persisted, except the coach

Overrides last for the run of the app. The trigger numbers are not `packages/config` keys and should
not become them: §16 step 3 wants tuning to end in a reviewed diff to `config.ts` against a corpus,
not a `settings.json` that makes one developer's Riki quietly different. Unprompted speech is a
privacy default REPO_SKELETON.md §7.2 requires to ship off, and a debug window that could make "on"
sticky is how that default would drift.

`coach.mode` is the exception and not one this feature invents — the control calls the shell's
`setCoachMode`, which the tray's Coach row already persists through. A panel and a checkbox
disagreeing about which coach is running would be worse than either being wrong alone.

Because a reading is now conditional on all of this, the window says so: an overridden control is
marked, its group is badged, and **the header carries a count of overrides in the loudest tone the
stylesheet has.** The realistic failure this panel introduces is somebody moving a threshold,
forgetting, and reporting that Riki will not stop talking. `ShellTelemetry.debugOverride` records
each change for the day `packages/telemetry` lands, which is the one place it is not already visible.

## 5. A separate window, not a panel

The overlay is `frame: false`, transparent, `focusable: false`, click-through, always-on-top,
created hidden and never destroyed, and budgeted to appear within 100 ms. None of that can hold a
scrollable inspector, and the product promise is that the visible surface is *invisible until
needed*. So the inspector is an ordinary window — title bar, focus, scrollbars, never on top — meant
for a second monitor.

It keeps exactly three of the overlay's settings, and they are not relaxed because this is a dev
tool: `contextIsolation`, `nodeIntegration: false`, `sandbox: true`. This renderer displays live
match state and the text composed to send to a model; it should be no more privileged than the one
that draws a chip. It gets its own preload entry and its own bridge key, so neither window can see
the other's surface.

Created on demand and destroyed on close — the reverse of the overlay, which is warmed and kept
because it has a latency budget. The inspector has none, and a renderer holding a frame every 250 ms
for a whole match while nobody looks at it is exactly the cost a debug tool must not impose.

### 5.1 Four intents, and one of them writes

`RikiDebugBridge` has two methods and `send` accepts four things: `ready`, `fault`, `action` and
`clear-trace`. `action` is the whole of the write surface — ADR-0037's `control` and ADR-0038's
`rehearse` are both gone, and neither is deferred: every row in the control registry described a
threshold or a gate in `packages/events`, and a rehearsal ran one coach turn. ADR-0042 deleted all
of it, so the two intents named things that no longer exist.

The id is checked at both boundaries and the two checks ask **different questions**:

- **Preload** asks whether the payload is *shaped* like an action intent: a non-empty, bounded id.
  That is all a boundary with no access to the registry can honestly check, and a copy of the
  registry here would be a second list to keep in step whose weaker half is the one this file was
  trusted for.
- **Main** asks whether the id names a **registered action that is not already running**. A refusal
  becomes an `inspector` problem in the Problems panel rather than a silence, because a button that
  appears to do nothing is the failure this window exists to make impossible.

**The reachable set is a registry, not a surface.** There is no `evaluate`, no way to name a field,
no way to reach a file, and nothing here can reach mute — which keeps the one producer ADR-0028 gave
it. `intents.test.ts` names what it must refuse, and `electron-window.ts`'s sender check still
matters: an `action` arriving from the overlay's `webContents` must not be honoured just because it
parses.

## 6. What it does not carry

**The player's transcript.** `DebugTurn.playerSaidChars` is a length. Everything else in a frame is
either a fact Riki derived or text Riki itself composed and was about to send to a model; the
player's speech is neither, and it is the one thing in this process that is nobody's business but
theirs (dota2 §7). The length is enough to tell "the transcript arrived and was empty" from "no
transcript arrived", which is the only thing about it this window needs to answer.

Riki's own transcript *is* carried — "what did it actually say" is half the reason the window
exists.

**That absence is why the no-tool-call mark is wider than the failure it hunts** (§2.1). It cannot
be narrowed without the question, and the question is not available at any price.

**And this is why the default is off.** With `debug.enabled` false the shell builds no hub, so no
rendered snapshot, tool result or transcript is held anywhere; installs no decorators; and offers no
tray row. Each is a reason on its own, and the first makes the default a privacy decision rather
than a performance one. `repo-hygiene.test.ts` asserts `RIKI_DEBUG=off` alongside `RIKI_CAPTIONS`
and `RIKI_UNPROMPTED`.

## 7. Bounds

Every buffer in `hub.ts` is capped by `DEBUG_LIMITS`, and every long text field is clipped on the
way in, with a marker — a snapshot that ends mid-line and one that *was rendered* mid-line look
identical otherwise, and the second is a real failure.

Tool results are the binding constraint on frame size and carry the tightest bound: forty turns ×
eight calls × 800 characters is the worst case a frame can hold, which is the same order as the
snapshot text beside it. Calls past the eighth in one turn are dropped oldest-first and **counted**
into `toolsDropped`, because a truncated list that reads like a complete one is the one thing this
window must never produce. A turn that made nine calls is itself a finding, so the cap is not the
place to make it disappear.

## 8. Enabling it

There is still no settings surface (`src/renderer/settings/` is a skeleton), but `packages/config`
has landed since this was written, so `debug.enabled` now has all three layers — flag, environment
and file:

```sh
RIKI_DEBUG=1 pnpm dev          # or --debug-enabled
```

```jsonc
// ~/Library/Application Support/Riki/settings.json   (macOS)
// ~/.config/Riki/settings.json                       (Linux)
{ "debug": { "enabled": true } }
```

Then **Riki ▸ Open Inspector…** in the tray. `docs/runbooks/dev-setup.md` has the full loop.

## 9. Open

1. ~~**⚠ The preload bridge does not load.**~~ **Fixed by ADR-0034**, which bundles every preload to
   `.cjs` — `dist/preload/debug.cjs` is in `scripts/bundle.mjs`'s target list. Verified in a real
   sandboxed Electron window on 2026-08-02 while building the Controls panel: `window.rikiDebug` is
   an object, a frame arrives over IPC and draws all nine panels, and clicking the real `+` stepper
   in the real renderer moved `speakThreshold` from 0.3 to 0.35 in main. So **main → renderer → main
   is now verified end to end**, which it was not when this document was written. The recipe is in
   the `overlay-ui` skill; it is a throwaway `main.mjs` under `xvfb-run`, and it is worth twenty
   minutes on any change to this window.
2. **No Tier 5 coverage.** The window itself is untested — there is no Playwright harness
   (REPO_SKELETON.md §10 step 6). Everything the inspector *collects* is Tier 1 and Tier 4, and
   `DebugSurfaceDeps.windows` is optional precisely so the collection can be driven with no window
   at all. What is unverified is the `BrowserWindow` configuration in `electron-window.ts`.
3. **`allies.*` is not shown.** It is keyed by hero and written only by CV, and the sidecar speaks
   no protocol yet (step 2). It gets a section beside `enemies` on the day something writes to it.
4. **No export.** Reading a frame is a live activity; there is no "save this session" button. A
   replay harness that dumped frames to disk would be the natural next thing, and the hub is already
   the right shape for it — `DebugSurfaceDeps.windows` being optional means a headless
   `pnpm dev:replay` can read frames straight off `hub.frame(now)`.
5. **Frames are whole, not diffed.** Fine at 4 Hz for a few kilobytes. Scroll position survives it
   (§2.3, ADR-0036) and so does keyboard focus, which `app.ts` restores by `data-focus` key; text
   selection inside a panel does not, and that is what the freeze button is for. The same redraw is
   why every control is a button rather than a text field.
6. **This is a tool, not a measurement.** It makes a turn's tool calls visible; it does not judge
   whether the model called the right tool, or enough of them. The no-tool-call mark is the one
   verdict it offers and it is deliberately a crude one (§2.1).
7. **The dispatch decorator is not wired yet.** `observeToolCalls` is written, exported and tested
   against a fake dispatcher, and the composition root does not install it — there is no
   `ToolDispatcher` to decorate until T4 of the conversational migration lands tool calling in the
   session. Wiring it is one call of the shape `observeSnapshots` already has. Until then the Turns
   panel's tool section renders the empty case for every turn, and **every spoken turn is marked**;
   that is the honest reading of "no call was recorded", but it will look like an alarm.
8. **A refused call has a producer that does not exist either.** `parseToolCall`'s three failures are
   the model getting the tool surface wrong, and the `refused` status is reachable only by whoever
   wires that branch (T4). The hub API is public for it; nothing calls it today.

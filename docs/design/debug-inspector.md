# The inspector — a live view of what Riki believes, and a way to argue with it

**Status:** Built. `apps/desktop/src/main/debug/`, `src/preload/debug.ts`,
`src/renderer/debug/`, off by default behind `config.debug.enabled`.
**Scope:** A dev-only window showing the judge's and the coach's real-time internal state, and
letting a developer move the settings behind it while a match runs (ADR-0037).
**Out of scope:** Telemetry sinks and log redaction (`packages/telemetry`, still a skeleton);
*doing* the tuning this window exists to make possible (coaching-trigger-architecture.md §16
step 3); the player-facing settings surface (`src/renderer/settings/`) — the Controls panel is a
developer tool that persists nothing, not a preferences window.

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

Three columns, one document, redrawn whole at 4 Hz — without moving the reader (§2.3).

| Panel | Answers |
|---|---|
| **Gate state** | The engine's mutable state: quiet mode, mute, agent/player speaking, intensity against its threshold, the global cooldown, the latch set, and every running per-kind cooldown |
| **World model** | Every observed `meta.*`, `self.*` and `map.*` leaf with its full envelope — value, source, confidence, staleness, age, and age *basis* |
| **Enemies / Derived** | Per-hero position or last-seen with staleness; every derived rule's answer, with `null` shown as *declined* rather than as zero |
| **Triggers** | Per tick: every ranked candidate with its salience, magnitude, confidence and deadline, and **all thirteen gates' verdicts on each** |
| **Coach turns** | Per turn: the snapshot and the brief exactly as rendered, which sections survived, which were omitted, the outcome, and what Riki said |
| **Counters and sources** | `TriggerCounters` per kind and per reason, bus depth, drops, `seq` gaps, and each source's liveness |
| **Problems** | Everything `ShellTelemetry` reports as a fault, which currently reaches nowhere else |
| **Controls** | Every setting the window may *move*, live — §4 |

### 2.1 The gate grid is the point

`TriggerPolicy.decide` ranks candidates and returns the first gate that refuses the winner. Three
things it computed are thrown away, and each of them is a question somebody actually has:

- **The losing candidates.** §5.5 is explicit that there is no fall-through, and the reasoning is
  sound — most gates are about *Riki* rather than about the candidate. But the runner-up's verdicts
  are still the answer to "why did nobody hear about the other thing".
- **The gates that passed.** A candidate that cleared twelve gates and died on `below_threshold` is
  a tuning problem. One that died on gate 1 is not a coaching problem at all. From a counter they
  are the same event.
- **The gates that would also have refused.** §5.2 rule 3 attributes a refusal to the *first* gate,
  deliberately. That is right for the counter and wrong for the person tuning it: relaxing the
  attributed gate does nothing if a second one is still there, and nothing else can tell you.

So the inspector evaluates the whole ladder against every ranked candidate and shows the grid, with
the deciding refusal styled apart from the shadowed ones.

### 2.2 Both coaches

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

**The three scrolling columns and the two header buttons are never rebuilt**, only refilled.
`scrollTop` belongs to the element, so a column recreated each frame has no position to preserve;
and a `<button>` recreated each frame takes keyboard focus to `<body>` with it. Everything inside a
column is still rebuilt whole — the property that keeps a stale node from surviving a redraw is
untouched. The Controls panel's own buttons live *inside* a column and are therefore
rebuilt, so `app.ts` restores keyboard focus by the `data-focus` key each of them carries — the
focus counterpart of what `scroll.ts` does for position, and the reason tabbing to a stepper or
holding `+` down works at all (§4.2).

**Position is content, not a number.** The panels that grow render newest-first, so a new tick is
prepended and every pixel offset below it is wrong the moment it lands. `renderer/debug/scroll.ts`
notes the topmost row on screen by the `data-ins-key` `view.ts` stamps on it — a `seq`, a `turnId`,
a fact path, never a render index — and puts that row back at the same height afterwards. The two
edges are pinned instead: at the top means *follow the newest*, which newest-first is where new rows
appear, and at the bottom means *keep the oldest row still* as the buffer grows above it.

Freeze is still worth having and is now about the values rather than the scrollbar: text selection
does not survive a redraw, and a gate ladder read live is read while it is replaced.

## 3. Shape

```
   TriggerPolicy ────decorated────►┐
   RikiContext   ────decorated────►│
   ShellTelemetry────decorated────►├──► DebugHub ──frame(now)──► DebugWindow ──IPC──► renderer/debug
   CoachingSessionPort ──subscribed►│         ▲
   world / health / counters ───────┘         └─ pulled at frame time, not pushed
```

Every seam is a thing the composition root already injects, so `packages/events` and
`packages/context` are **unchanged by this component**. That is not tidiness — it is the reason the
inspector can be trusted, because there is no version of the trigger path that only runs when
somebody is watching.

### 3.1 Push for edges, pull for state

Ticks, turns and problems are pushed: they are events, they happen whether or not the window is
open, and missing one is missing the thing you opened it to see. Ticks therefore accumulate from the
moment the hub exists — the most useful moment to open an inspector is just *after* something looked
wrong.

The world model, the engine's switches, health and the counters are pulled when a frame is built.
They are current-value questions, and pushing them would mean building a projection thirty times a
second into a buffer nobody reads.

### 3.2 Why the policy is the seam for engine state

`EventEngine` exposes `counters()`, four setters, and the tape. The latch set, the per-kind cooldown
clocks and the intensity score are private to it — correctly, since they are its invariants and an
accessor is an invitation to write to them. But `GateContext` is assembled from all of them once per
tick and handed to the policy, so decorating the policy sees everything without widening the
engine's surface.

The cost is stated where it shows: those values are current as of the last world-model version bump,
not as of the frame. The panel is labelled *"as of the last tick, N ago"* rather than presented as
live.

### 3.3 Why the context is the seam for turn text

`openTurn` renders the snapshot and the brief, appends both to the ledger, and returns them to the
agent, which composes them into one system message and forgets them. Decorating `RikiContext` in the
composition root covers every caller — the coaching path, the player path, and any future one — with
no change to `createCoachingAgent`, whose correctness is load-bearing when the inspector is off.

It is spread-and-override, which relies on `createContextAssembler` returning a plain record.
`observing-context.test.ts` asserts that every key of a real assembler survives the wrap, so the
assumption fails a test rather than failing silently.

## 4. What it can and cannot change

### 4.1 It changes nothing on its own

The load-bearing property, and each part of it is enforced somewhere:

| Claim | Enforced by |
|---|---|
| The policy decorator returns the delegate's decision | `observing-policy.test.ts` asserts object *identity*, not deep equality |
| The context decorator returns the assembler's turn | `observing-context.test.ts`, and the ledger still receives both appends |
| The telemetry decorator never swallows an event | `telemetry.test.ts` walks every member of `ShellTelemetry` reflectively, keyed off `nullTelemetry()`, and asserts each one reached the delegate — so an arm that mirrors a fault but drops its `delegate.` line fails, and a member added later is covered the day it compiles |
| An untouched inspector is inert end to end | `shell.test.ts` replays `fixtures/gsi/laning-phase.jsonl` twice, with the flag off and on, and asserts the same utterances come out |
| The live config, gates and detectors are the real ones until moved | `controls.test.ts` compares each against `DEFAULT_TRIGGER_CONFIG`, `GATES` and `DETECTORS` field by field and verdict by verdict |

The fourth is the test worth having. In a product whose failure mode is Riki talking when it should
not, a debug tool that perturbs the trigger path *by existing* is worse than no debug tool.

A gate that throws is reported as **refusing**, not passing. The inspector asks all thirteen gates
about candidates the shipping path would have short-circuited past, so it is the one place in the
app that can provoke a gate with an input the policy never would — and an answer that cannot be
relied on should not look like a pass.

### 4.2 …and when it does, it is one row of a registry

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

### 5.1 Four intents, and two of them write

`RikiDebugBridge` has two methods and `send` accepts four things: `ready`, `fault`, `control` and
`reset-controls`. The last two make this the widest renderer surface in the app — it was the least
privileged process and is now the most — so the allow-list is checked at both boundaries and the two
checks ask **different questions**:

- **Preload** asks whether the payload is *shaped* like a control intent: a non-empty id, a value
  that is a boolean, a finite number or a string, both bounded. That is all a boundary with no access
  to the registry can honestly check, and a copy of the registry here would be a second list to keep
  in step whose weaker half is the one this file was trusted for.
- **Main** asks whether the id names a **registered, unlocked control**. A refusal becomes an
  `inspector` problem in the Problems panel rather than a silence, because a control that appears to
  do nothing is the failure this window exists to make impossible.

There is still no `evaluate`, no `speak`, no "replay this tick", and no way to name a field rather
than a control. The window can turn knobs the app was built with; it cannot drive the app.
`intents.test.ts` names what it must refuse, and `electron-window.ts`'s sender check matters more
than it did: a `control` arriving from the overlay's `webContents` must not be honoured just because
it parses.

## 6. What it does not carry

**The player's transcript.** `DebugTurn.playerSaidChars` is a length. Everything else in a frame is
either a fact Riki derived or text Riki itself composed and was about to send to a model; the
player's speech is neither, and it is the one thing in this process that is nobody's business but
theirs (dota2 §7). The length is enough to tell "the transcript arrived and was empty" from "no
transcript arrived", which is the only thing about it this window needs to answer.

The coach's transcript *is* carried — "what did it actually say" is half the reason the window
exists.

**And this is why the default is off.** With `debug.enabled` false the shell builds no hub, so no
rendered snapshot, brief or coach transcript is held anywhere; installs no observing policy, so the
extra gate evaluations never run; and offers no tray row. Each is a reason on its own, and the first
makes the default a privacy decision rather than a performance one. `repo-hygiene.test.ts` asserts
`RIKI_DEBUG=off` alongside `RIKI_CAPTIONS` and `RIKI_UNPROMPTED`.

## 7. Bounds

Every buffer in `hub.ts` is capped by `DEBUG_LIMITS`, and the two long text fields are clipped on
the way in, with a marker — a snapshot that ends mid-line and one that *was rendered* mid-line look
identical otherwise, and the second is a real failure.

Empty ticks are counted but not kept. A match spends most of its time producing them, and retaining
them would push every interesting tick out of a 200-entry buffer within seconds. The count survives
in `counters.ticks`, which is what keeps *"the engine is not running"* distinguishable from *"the
engine found nothing"* — the same distinction §5.4 is built around, one level up.

`not_in_match` ticks are hidden by default in the view, with a count of how many were hidden. During
a draft, a post-game screen, or any Turbo or Ability Draft game, the detectors keep producing
candidates and the ladder refuses every one at the first question. Those ticks are correct, and there
are thousands of them.

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
6. **This is a tool, not a measurement.** It makes the thresholds in `packages/events/src/config.ts`
   inspectable *and movable*; it does not tune them, and it does not judge the result. That is still
   coaching-trigger-architecture.md §16 step 3 — which now needs a person with a corpus and an
   opinion, rather than a person with a corpus, an opinion and a rebuild between every reading.
7. **Settings only, not actions.** "Force a tick", "clear the latches", "say this now" are all
   useful and none is a control. Each needs surface on `EventEngine` or `CoachingAgent` that ADR-0032
   declined to add and ADR-0037 went on declining; adding one is a decision, not an extension.
8. **No sweep.** `DebugSurface.controls` is exposed so a headless replay can move a threshold between
   runs, which is the shape a `pnpm dev:replay` sweep would use — nothing does yet.

# The inspector — a live view of what Riki believes

**Status:** Built. `apps/desktop/src/main/debug/`, `src/preload/debug.ts`,
`src/renderer/debug/`, off by default behind `config.debug.enabled`.
**Scope:** A dev-only window showing the judge's and the coach's real-time internal state.
**Out of scope:** Telemetry sinks and log redaction (`packages/telemetry`, still a skeleton);
tuning the thresholds this window exists to make tunable (coaching-trigger-architecture.md §16
step 3); the settings surface that would give this a checkbox (`src/renderer/settings/`).

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

Three columns, one document, redrawn whole at 4 Hz.

| Panel | Answers |
|---|---|
| **Gate state** | The engine's mutable state: quiet mode, mute, agent/player speaking, intensity against its threshold, the global cooldown, the latch set, and every running per-kind cooldown |
| **World model** | Every observed `meta.*`, `self.*` and `map.*` leaf with its full envelope — value, source, confidence, staleness, age, and age *basis* |
| **Enemies / Derived** | Per-hero position or last-seen with staleness; every derived rule's answer, with `null` shown as *declined* rather than as zero |
| **Triggers** | Per tick: every ranked candidate with its salience, magnitude, confidence and deadline, and **all thirteen gates' verdicts on each** |
| **Coach turns** | Per turn: the snapshot and the brief exactly as rendered, which sections survived, which were omitted, the outcome, and what Riki said |
| **Counters and sources** | `TriggerCounters` per kind and per reason, bus depth, drops, `seq` gaps, and each source's liveness |
| **Problems** | Everything `ShellTelemetry` reports as a fault, which currently reaches nowhere else |

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

## 4. It cannot change what the app does

The load-bearing property, and each half of it is enforced somewhere:

| Claim | Enforced by |
|---|---|
| The policy decorator returns the delegate's decision | `observing-policy.test.ts` asserts object *identity*, not deep equality |
| The context decorator returns the assembler's turn | `observing-context.test.ts`, and the ledger still receives both appends |
| The telemetry decorator never swallows an event | `telemetry.test.ts` walks every member of `ShellTelemetry` reflectively, keyed off `nullTelemetry()`, and asserts each one reached the delegate — so an arm that mirrors a fault but drops its `delegate.` line fails, and a member added later is covered the day it compiles |
| The whole thing is inert end to end | `shell.test.ts` replays `fixtures/gsi/laning-phase.jsonl` twice, with the flag off and on, and asserts the same utterances come out |

That last one is the test worth having. In a product whose failure mode is Riki talking when it
should not, a debug tool that perturbs the trigger path is worse than no debug tool.

A gate that throws is reported as **refusing**, not passing. The inspector asks all thirteen gates
about candidates the shipping path would have short-circuited past, so it is the one place in the
app that can provoke a gate with an input the policy never would — and an answer that cannot be
relied on should not look like a pass.

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

### 5.1 Read-only by construction

`RikiDebugBridge` has two methods. `send` accepts `ready` and `fault` and nothing else. There is
deliberately no `setQuietMode`, no `evaluate`, no "replay this tick": an inspector that can poke the
thing it inspects produces readings nobody can act on, and it would be the widest privilege
escalation in the app. `parseDebugIntent` is the allow-list, checked at both boundaries, and
`intents.test.ts` names the things it must refuse.

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

There is no settings surface (`src/renderer/settings/` is a skeleton) and `packages/config` has not
landed, so `.env` is not read (`main/bootstrap.ts`). Until then:

```jsonc
// ~/Library/Application Support/Riki/settings.json   (macOS)
// ~/.config/Riki/settings.json                       (Linux)
{ "debug": { "enabled": true } }
```

Then **Riki ▸ Open Inspector…** in the tray. `docs/runbooks/dev-setup.md` has the full loop.

## 9. Open

1. **⚠ The preload bridge does not load — for this window or the overlay's.** Discovered while
   verifying this feature in a real Electron process, and it is pre-existing rather than caused by
   it: `webContents.on('preload-error')` fires with `Cannot use import statement outside a module`,
   and `window.rikiOverlay` is absent too. Two causes stack — `tsc` emits ESM because
   `apps/desktop/package.json` is `"type": "module"` and Electron loads preloads as CommonJS, and a
   **sandboxed preload must be a single self-contained file**, so even a CJS build fails on
   `require('./debug-bridge.js')`. Fixing it needs a preload bundling step, which REPO_SKELETON.md
   §8.1 defers to "when Vite lands"; the options and their costs are in the `overlay-ui` skill.
   Everything else here works: `main/debug/` collects correctly against the fixture corpus, and the
   renderer draws correctly in a real sandboxed window with the real CSP and stylesheet when the
   bridge is supplied. The one unverified hop is main → renderer over IPC.
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
5. **Frames are whole, not diffed.** Fine at 4 Hz for a few kilobytes; the cost is that text
   selection and scroll position inside a panel are lost on every redraw, which is what the freeze
   button is for.
6. **This is a tool, not a measurement.** It makes the thresholds in `packages/events/src/config.ts`
   *inspectable*; it does not tune them. That is still
   coaching-trigger-architecture.md §16 step 3, and it now has something to look at while it happens.

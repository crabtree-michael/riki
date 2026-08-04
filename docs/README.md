# Riki documentation

The index. What is here, what is decided, and what is still open.

Docs are split by kind, because "design doc" was covering four different things:

| Directory                | Holds                                               | Read it when                                                |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------------- |
| [`design/`](design/)     | How a subsystem should work                         | You are about to build that subsystem                       |
| [`research/`](research/) | What we learned about something outside our control | You need to know how an external API behaves                |
| [`adr/`](adr/)           | What we decided and why, one page each              | Before proposing an alternative — it may already be settled |
| [`runbooks/`](runbooks/) | How to do a thing, and what happened when we did    | You are doing that thing                                    |

## Design

- [**ui-design.md**](design/ui-design.md) — the overlay chip, its states and motion, the tray,
  hotkeys, accessibility, and the settings surface.
- [**overlay-architecture.md**](design/overlay-architecture.md) — how that surface is built: the
  interaction machine, the window, the preload bridge, and the seams between the overlay and the
  voice system. Read it with `ui-design.md`, which is the *what* to its *how*.
- [**dota2-state-capture-design.md**](design/dota2-state-capture-design.md) — how Riki observes a
  live match: GSI, the console log tailer, the capture/CV sidecar, fusion into a world model, and
  what the agent is shown.
- [**state-capture-architecture.md**](design/state-capture-architecture.md) — the module and class
  architecture that implements it: the fact envelope, the source interface, the fusion reducer and
  its policies, and the read interface `context` and `events` consume. **Built**, except the
  composition root — start at §13, which records where the code differs from §3–§7.
- [**coaching-architecture.md**](design/coaching-architecture.md) — how Riki decides a moment is
  worth speaking about and what the model is shown for it: the coaching brief, `BRIEF_PLAN`, where
  voice intents and the overlay route, and the revised budgets. It is also the record of what was
  deleted to get here — `agent-command-execution-architecture.md` described a command execution
  system that no longer exists, and [ADR-0023](adr/0023-coaching-replaces-command-execution.md)
  removed both. **Built**, and its trigger half has a sibling document below; §6.6 records where
  the two designs meet, and every row of it is now closed.
- [**coaching-trigger-architecture.md**](design/coaching-trigger-architecture.md) — the other half
  of coaching: what makes Riki decide a moment is worth speaking about. Detection over the world
  model, the salience score, the thirteen gates that refuse and how each one is counted, the
  mid-fight intensity signal, and the composition root where the two halves finally meet.
  **Built**, except the tuning — every coefficient in it is a starting point with no measurement
  behind it, which is open questions 19 and 20.
- [**llm-coach-architecture.md**](design/llm-coach-architecture.md) — the second coach: an OpenAI
  Agents SDK model that decides for itself whether Riki should speak and drafts the line, as a
  runtime alternative to the thirteen gates rather than a stage inside them
  ([ADR-0031](adr/0031-the-llm-coach-is-an-alternative-not-a-stage.md)). **Built.** Read §4.3 before
  adding anything to the skip list — the six mechanical skips are the whole of what is allowed to
  refuse, and §14 is what is still open.
- [**hero-library.md**](design/hero-library.md) — the coaching knowledge the world model does not
  have: twenty top-tier heroes, six topics each, one line per note, surfaced as the `library` brief
  section and refreshed by nothing ([ADR-0027](adr/0027-the-hero-library-is-static.md)). **Built.**
  Read §3 before editing content — the policy is what keeps a static library from ageing into being
  wrong rather than merely old.
- [**debug-inspector.md**](design/debug-inspector.md) — the dev-only window that answers *what does
  Riki believe, what did it nearly say, why did it stay quiet*, and *what happens if I move this
  number*: the world model with every fact's provenance, every candidate against all thirteen gates,
  the snapshot and brief as composed for each turn, every fault the app reports and currently cannot
  log, and a live control for every number in `packages/events/src/config.ts`. **Built**, off by
  default ([ADR-0032](adr/0032-the-inspector-observes-by-decoration.md),
  [ADR-0037](adr/0037-the-inspector-is-a-control-surface-within-a-registry.md)). Read it before
  adding a hook or a setter to `packages/events` or `packages/context` — the reason it needed
  neither is §3 and §4.2.
- [**context-and-memory-architecture.md**](design/context-and-memory-architecture.md) — what the
  agent is given and what Riki remembers: the frozen session preamble, the per-turn snapshot
  renderer, the shared rendering primitives, and the memory layer underneath — the conversation
  ledger, coaching memory, the context-window retention policy, and durable cross-match player
  memory. The other half of `packages/context`, alongside the command architecture above.
- [**voice-input-architecture.md**](design/voice-input-architecture.md) — the voice path end to
  end: microphone capture and gating, the real-time audio pipeline, the Realtime session and its
  turn-taking, transcription and local command parsing, and the class structure of
  `packages/audio` and `packages/realtime`. Read it with `openai-realtime-research.md`, which is
  what the API does to its what-we-do-about-it.

## Research

- [**audio-ducking-platform-support.md**](research/audio-ducking-platform-support.md) — whether one
  application can lower another's volume, per platform. The answer on macOS is no, which is why
  [ADR-0020](adr/0020-ducking-is-a-no-op-by-default.md) exists and why `Ducker.available` is false
  on the primary target.
- [**web-search-providers.md**](research/web-search-providers.md) — whether a search API's terms let
  us cache results to disk and read them aloud. Brave forbids it in writing and nobody grants it on
  self-serve; measured p95 is ~3.5 s against a budget three orders of magnitude smaller. Together
  those are why the hero library is static content rather than a live search
  ([ADR-0027](adr/0027-the-hero-library-is-static.md)). Read it before proposing a live one.
- [**openai-realtime-research.md**](research/openai-realtime-research.md) — the Realtime API:
  transports, session configuration, barge-in, context growth, cost, and the failure modes that
  bite.

## Decisions

Numbered, one page each, and the first place to look before re-opening a question.

| ADR                                                       | Decision                                 | Status                                         |
| --------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| [0001](adr/0001-electron-shell.md)                        | Electron + TypeScript for the shell      | Accepted, with a condition that can invert it  |
| [0002](adr/0002-webrtc-transport.md)                      | WebRTC as the Realtime transport         | Accepted                                       |
| [0003](adr/0003-read-only-observation-only.md)            | Read-only observation only               | Accepted — not open for re-litigation          |
| [0004](adr/0004-push-to-talk-default.md)                  | Push-to-talk by default                  | Accepted                                       |
| [0005](adr/0005-monorepo-and-protocol-package.md)         | Monorepo with a central protocol package | Accepted                                       |
| [0006](adr/0006-env-var-api-key-for-alpha-beta.md)        | Env-var API key for alpha/beta           | Accepted, expected to be superseded            |
| [0007](adr/0007-superpowers-plugin-enabled-by-default.md) | Superpowers plugin on by default         | Implemented (long-form; predates the template) |
| [0008](adr/0008-pre-commit-is-the-gate.md)                | Pre-commit is the gate; CI deleted       | Accepted                                       |
| [0009](adr/0009-overlay-state-machine-in-main.md)         | Interaction state machine in main        | Accepted                                       |
| [0010](adr/0010-dedicated-voice-window.md)                | A hidden window owns the microphone      | Accepted (by `packages/realtime`, 2026-08-01)  |
| [0011](adr/0011-tool-manifest-frozen-per-session.md)      | Command manifest frozen per session      | **Superseded** by 0023 — there is no manifest  |
| [0012](adr/0012-conversation-ledger-is-ours.md)           | Riki keeps its own conversation ledger   | Accepted                                       |
| [0013](adr/0013-durable-memory-is-typed-observations.md)  | Durable memory is typed, local, no free text | Accepted, one default needs a human call   |
| [0014](adr/0014-observation-reducer-seam.md)              | Observation seam + pure fusion reducer   | Accepted                                       |
| [0015](adr/0015-ephemeral-client-secret-minted-in-main.md) | Main mints the ephemeral client secret  | Accepted                                       |
| [0016](adr/0016-mic-open-for-the-match-gate-in-the-graph.md) | Mic open per match; the gate is ours  | Accepted                                       |
| [0017](adr/0017-server-vad-on-with-response-creation-ours.md) | Server VAD on, response creation ours | Accepted, on one unverified claim              |
| [0018](adr/0018-argument-schemas-from-a-local-declaration.md) | Argument schemas from a local declaration, not zod yet | **Superseded** by 0023 — there are no arguments |
| [0019](adr/0019-get-build-benchmark-is-reference-class.md) | `get_build_benchmark` is a `reference` command | **Superseded** by 0023 — survives as a brief constraint |
| [0020](adr/0020-ducking-is-a-no-op-by-default.md)         | Ducking is a no-op by default            | Accepted — macOS has no public API             |
| [0021](adr/0021-speech-occupies-the-window-as-audio.md)   | Speech is costed as audio, not as its transcript | Accepted, on one estimated constant    |
| [0022](adr/0022-the-api-key-is-an-opaque-type.md)         | The API key is an opaque type            | Accepted — closes the accidental-log class     |
| [0023](adr/0023-coaching-replaces-command-execution.md)   | Proactive coaching replaces command execution | Accepted — supersedes 0011, 0018 and 0019      |
| [0024](adr/0024-suppression-is-counted-the-ledger-records-transitions.md) | Suppression is counted; the ledger records transitions | Accepted — corrects one row of coaching §13    |
| [0025](adr/0025-packages-export-source-to-the-toolchain.md) | Packages export source to the toolchain and `dist` to Node | Accepted — what made `pnpm dev` possible without a bundler |
| [0026](adr/0026-the-coaching-root-is-built-per-match.md) | The coaching root is built per match, not per app | Accepted — the lifetime step 6 had to decide   |
| [0027](adr/0027-the-hero-library-is-static.md)            | The hero library is static; nothing refreshes it | Accepted — no network at runtime          |
| [0028](adr/0028-mute-has-one-producer-the-menu-row.md)    | Mute has one producer, and it is the menu row | Accepted — amends ui-design §2.3's click gesture |
| [0029](adr/0029-newline-delimited-json-over-stdio-with-a-hello-ready-handshake.md) | Newline-delimited JSON over stdio, hello/ready handshake | Accepted — the sidecar wire format |
| [0030](adr/0030-the-capture-seam-returns-cropped-regions-never-frames.md) | The capture seam returns cropped regions, never frames | Accepted — window-only and crop-first, structurally |
| [0031](adr/0031-the-llm-coach-is-an-alternative-not-a-stage.md) | The LLM coach is an alternative to the gates, not a stage inside them | Accepted — the deterministic coach stays the default |
| [0032](adr/0032-the-inspector-observes-by-decoration.md) | The inspector observes by decoration, and can change nothing | Accepted — dev-only, off by default; the read-only half is amended by ADR-0037 |
| [0033](adr/0033-screencapturekit-is-the-shipping-backend.md) | `ScreenCaptureKit` is the shipping backend, and it is cross-compiled rather than run | Accepted — macOS captures; six things still need a Mac |
| [0034](adr/0034-the-voice-renderer-is-bundled-the-overlay-is-not.md) | The voice renderer is bundled; the overlay is not | Accepted — and the preloads are bundled to CommonJS, which is why the overlay's had never loaded |
| [0035](adr/0035-the-vision-leg-is-testable-because-a-fake-speaks-the-protocol.md) | The vision leg is testable because a fake speaks the protocol, not because the app has a second wiring | Accepted — `FakeVisionSidecar` at the `ChildProcessPort` seam; the codec's wire→world-model translation was missing entirely |
| [0036](adr/0036-the-inspector-anchors-on-content-not-on-offset.md) | The inspector anchors on content, not on an offset | Accepted — the three columns survive the redraw; a prepending list makes a saved `scrollTop` wrong |
| [0037](adr/0037-the-inspector-is-a-control-surface-within-a-registry.md) | The inspector is a control surface, within a registry | Accepted — amends ADR-0032's read-only half; inert unless clicked, and `packages/events` still has no setter |
| [0038](adr/0038-a-rehearsal-is-a-turn-against-a-world-nobody-is-playing.md) | A rehearsal is a coach turn against a world nobody is playing | Accepted — extends ADR-0037 to one action; a scratch coaching root, and no session is reachable from it |

New decisions use [the template](adr/0000-template.md). If you made a design decision, it is an
ADR — not a comment in the code.

**Claim the next free number from `ls docs/adr/` immediately before you commit, not from this
table and not at the start of your task** — the table lags by a commit, and the gap is long enough
for another agent to take the number. Two ADR-0008s landed that way, then two ADR-0012s; the later
of each pair was renumbered afterwards, which means moving a file and chasing its inbound links.

## Runbooks

- [**claude-plugin-setup.md**](runbooks/claude-plugin-setup.md) — the shared Claude Code
  configuration and how to opt out of it.
- [**anticheat-validation.md**](runbooks/anticheat-validation.md) — **not yet run.** A blocking
  risk for the hotkey and overlay layer.
- [**perf-results/**](runbooks/perf-results/) — committed frame-time numbers. A release that has
  not run the harness is not a release.

## Structure and process

- [**REPO_SKELETON.md**](../REPO_SKELETON.md) — directory layout, testing strategy, linting
  gates, environment configuration, and the build/dev workflow.
- [**AGENTS.md**](../AGENTS.md) — how agents work here and what "done" means.
- [**CONTRIBUTING.md**](../CONTRIBUTING.md) — human-facing setup and workflow.

## Open questions

These need a human call or a spike. They are collected here because previously they sat at the
bottom of three separate documents where nobody found them. Full statements in
[REPO_SKELETON.md](../REPO_SKELETON.md) §11 and at the end of each design doc.

| #   | Question                                                                                                               | Needed by                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Electron vs. Tauri — does Electron's memory footprint survive the frame-time harness on a median machine?              | Before `apps/desktop` gains real depth                    |
| 2   | How does a non-developer user get an API key?                                                                          | Before the first build goes to anyone outside the team    |
| 3   | git-lfs for `fixtures/frames/`, or a scripted download from object storage?                                            | Before the frame corpus grows                             |
| 4   | Rust vs. C++ for the sidecar — how mature are the ScreenCaptureKit bindings really?                                    | During the CV spike                                       |
| 5   | Where does the agent's prompt/persona live? Proposal: versioned files in `packages/context/prompts/` with golden tests. **More urgent since [ADR-0023](adr/0023-coaching-replaces-command-execution.md)**: with no tool descriptions, the preamble persona is the only thing shaping how Riki sounds, and "say when you do not know" is now a rule the product depends on | With `packages/context` |
| 6   | Anti-cheat: is a global hook plus an always-on-top window viable?                                                      | **Blocking** — before any UI is built on the hotkey layer |
| 7   | ~~Does the Realtime session get its own hidden window?~~ **Settled** — yes ([ADR-0010](adr/0010-dedicated-voice-window.md), now Accepted) | — |
| 8   | Who scrubs other players' chat before it can reach an on-screen caption?                                               | Before caption mode ships                                 |
| 9   | ~~May consent for `read_screen` be remembered for a match, or is it per call?~~ **Closed** by [ADR-0023](adr/0023-coaching-replaces-command-execution.md) — `read_screen` is deleted, and nothing Riki does needs consent or a permission prompt | — |
| 10  | ~~Can the Realtime API emit more than one function call per response?~~ **Closed** by [ADR-0023](adr/0023-coaching-replaces-command-execution.md) — it decided whether the command queue needed to exist, and the queue does not exist | — |
| 11  | Does Riki's own context injection really dominate the window, filling it in ~38 min? It sizes the whole retention design ([context-and-memory §7.1, §12](design/context-and-memory-architecture.md)). **Inputs changed**: command results were ~200 of the ~750 tokens/min and are now zero; [coaching §8.2](design/coaching-architecture.md) re-derives it as ~675 and ~42 min | Before `RetentionPolicy` numbers are load-bearing |
| 12  | Should durable player memory be on by default? [ADR-0013](adr/0013-durable-memory-is-typed-observations.md) says yes on structural grounds; REPO_SKELETON §7.2 says privacy-relevant defaults are off | With the first-run consent flow                           |
| 13  | Does post-match review ship, and does the conversation ledger therefore persist? It holds the player's own voice transcript | Before post-match review is built                          |
| 14  | Does Chromium's echo cancellation survive a `getUserMedia` stream routed through Web Audio? A tone and an analyser answer it ([voice-input §3.4](design/voice-input-architecture.md)) | **Blocking** — before the capture graph or its pre-roll is built |
| 15  | Is `input_audio_buffer.commit` honoured on WebRTC with VAD on? If yes, every turn gets up to 400 ms faster ([voice-input §5.4](design/voice-input-architecture.md)) | Before the release→speaking budget is tuned                |
| 16  | Does `turn_detection: 'none'` really disable server-side barge-in truncation? [ADR-0017](adr/0017-server-vad-on-with-response-creation-ours.md) assumes yes from the shape of the API, not from a documented statement | Before that ADR is treated as settled                      |
| 17  | Is Riki's TTS intelligible over **un-ducked** Dota audio, and does output-side compression fix it? [ADR-0020](adr/0020-ducking-is-a-no-op-by-default.md) removes ducking on the primary platform, which makes ui-design §7.2's "the player will just stop using the feature" unmitigated. A listening test, not a spike | Before voice ships to anyone outside the team |
| 18  | Does a ~150-token focused coaching brief carry as much useful signal as a tool call did? The core bet of [ADR-0023](adr/0023-coaching-replaces-command-execution.md); if it is false, either the brief grows or some pull mechanism comes back ([coaching §12](design/coaching-architecture.md)) | Before the coaching brief's budget is load-bearing |
| 19  | Is proactive coaching at the default thresholds welcome rather than irritating? dota2 §6.4 calls unprompted speech the feature most likely to make Riki annoying enough to uninstall, and [ADR-0023](adr/0023-coaching-replaces-command-execution.md) makes it the primary path. Needs a person playing a real match, not a fixture | Before coaching ships to anyone outside the team |
| 20  | Are the salience coefficients right? Every number in `packages/events/src/config.ts` is a starting point with no measurement behind it; the ordering they encode is the claim and the gaps between them are guesses ([coaching-trigger §4.5, §12](design/coaching-trigger-architecture.md)) | Before anyone concludes the trigger policy is wrong rather than untuned |
| 21  | Does `packages/world-model` grow `derived.threats`, `derived.pace*` and a position-to-map-region table? Without them the `threat`, `pace`, `seen` and `map` renderings are omitted rather than wrong — the composition root refuses to compute them because the result would carry no provenance ([coaching-trigger §9.2, §15](design/coaching-trigger-architecture.md)) | Before the brief's content is judged against open question 18 |
| 22  | Does the macOS capture backend actually capture? [ADR-0033](adr/0033-screencapturekit-is-the-shipping-backend.md) ships it compile-verified for `aarch64-apple-darwin` and never executed: the permission dialog, real frames, the perf budget, exclusive fullscreen, multi-monitor scale and one `unsafe impl Send` are all unobserved. Its Consequences section is the checklist | Before vision is enabled for anyone, on the first session with a Mac |
| 23  | What is the real minimap-to-world-unit mapping? [ADR-0035](adr/0035-the-vision-leg-is-testable-because-a-fake-speaks-the-protocol.md) converts a minimap point with `MAP_WORLD_EXTENT_UNITS = 16576` and the guessed crop rectangle in `DEFAULT_CAPTURE_REGIONS`, neither measured. `enemy_missing` is unaffected — it never reads the position — but `nearbyEnemies`' 2000-unit radius means whatever that scale means | With the same Mac session as 22, before intensity or `nearby` is tuned |

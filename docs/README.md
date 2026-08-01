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
  its policies, and the read interface `context` and `events` consume.
- [**agent-command-execution-architecture.md**](design/agent-command-execution-architecture.md) —
  what happens when the agent asks Riki something: parsing and validating a tool call, the four
  ports it may reach, queueing and deadlines, the failure taxonomy, and the token budget. Read it
  with `state-capture-architecture.md` §7, whose read interface it consumes.
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
| [0011](adr/0011-tool-manifest-frozen-per-session.md)      | Command manifest frozen per session      | Accepted, on one unmeasured claim              |
| [0012](adr/0012-conversation-ledger-is-ours.md)           | Riki keeps its own conversation ledger   | Accepted                                       |
| [0013](adr/0013-durable-memory-is-typed-observations.md)  | Durable memory is typed, local, no free text | Accepted, one default needs a human call   |
| [0014](adr/0014-observation-reducer-seam.md)              | Observation seam + pure fusion reducer   | Accepted                                       |
| [0015](adr/0015-ephemeral-client-secret-minted-in-main.md) | Main mints the ephemeral client secret  | Accepted                                       |
| [0016](adr/0016-mic-open-for-the-match-gate-in-the-graph.md) | Mic open per match; the gate is ours  | Accepted                                       |
| [0017](adr/0017-server-vad-on-with-response-creation-ours.md) | Server VAD on, response creation ours | Accepted, on one unverified claim              |
| [0018](adr/0018-argument-schemas-from-a-local-declaration.md) | Argument schemas from a local declaration, not zod yet | Accepted, migrate when protocol lands |
| [0019](adr/0019-get-build-benchmark-is-reference-class.md) | `get_build_benchmark` is a `reference` command | Accepted, corrects the design doc          |
| [0020](adr/0020-ducking-is-a-no-op-by-default.md)         | Ducking is a no-op by default            | Accepted — macOS has no public API             |

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
| 5   | Where does the agent's prompt/persona live? Proposal: versioned files in `packages/context/prompts/` with golden tests | With `packages/context`                                   |
| 6   | Anti-cheat: is a global hook plus an always-on-top window viable?                                                      | **Blocking** — before any UI is built on the hotkey layer |
| 7   | ~~Does the Realtime session get its own hidden window?~~ **Settled** — yes ([ADR-0010](adr/0010-dedicated-voice-window.md), now Accepted) | — |
| 8   | Who scrubs other players' chat before it can reach an on-screen caption?                                               | Before caption mode ships                                 |
| 9   | May consent for `read_screen` be remembered for a match, or is it per call? Per call is the default until someone decides otherwise | Before `read_screen` ships                                |
| 10  | Can the Realtime API emit more than one function call per response? It decides whether the command queue needs to exist at all | Before `packages/context/src/tools/queue.ts` is written   |
| 11  | Does Riki's own context injection really dominate the window, filling it in ~38 min? It sizes the whole retention design ([context-and-memory §7.1, §12](design/context-and-memory-architecture.md)) | Before `RetentionPolicy` numbers are load-bearing          |
| 12  | Should durable player memory be on by default? [ADR-0013](adr/0013-durable-memory-is-typed-observations.md) says yes on structural grounds; REPO_SKELETON §7.2 says privacy-relevant defaults are off | With the first-run consent flow                           |
| 13  | Does post-match review ship, and does the conversation ledger therefore persist? It holds the player's own voice transcript | Before post-match review is built                          |
| 14  | Does Chromium's echo cancellation survive a `getUserMedia` stream routed through Web Audio? A tone and an analyser answer it ([voice-input §3.4](design/voice-input-architecture.md)) | **Blocking** — before the capture graph or its pre-roll is built |
| 15  | Is `input_audio_buffer.commit` honoured on WebRTC with VAD on? If yes, every turn gets up to 400 ms faster ([voice-input §5.4](design/voice-input-architecture.md)) | Before the release→speaking budget is tuned                |
| 16  | Does `turn_detection: 'none'` really disable server-side barge-in truncation? [ADR-0017](adr/0017-server-vad-on-with-response-creation-ours.md) assumes yes from the shape of the API, not from a documented statement | Before that ADR is treated as settled                      |
| 17  | Is Riki's TTS intelligible over **un-ducked** Dota audio, and does output-side compression fix it? [ADR-0020](adr/0020-ducking-is-a-no-op-by-default.md) removes ducking on the primary platform, which makes ui-design §7.2's "the player will just stop using the feature" unmitigated. A listening test, not a spike | Before voice ships to anyone outside the team |

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

## Research

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
| [0008](adr/0008-observation-reducer-seam.md)              | Observation seam + pure fusion reducer   | Accepted                                       |
| [0008](adr/0008-pre-commit-is-the-gate.md)                | Pre-commit is the gate; CI deleted       | Accepted — ⚠ number collides with the row above |
| [0009](adr/0009-overlay-state-machine-in-main.md)         | Interaction state machine in main        | Accepted                                       |
| [0010](adr/0010-dedicated-voice-window.md)                | A hidden window owns the microphone      | Proposed — `packages/realtime` owns the call   |
| [0011](adr/0011-tool-manifest-frozen-per-session.md)      | Command manifest frozen per session      | Accepted, on one unmeasured claim              |

New decisions use [the template](adr/0000-template.md). If you made a design decision, it is an
ADR — not a comment in the code.

Two agents landed an ADR-0008 in parallel and neither renumbered; both files are listed above so
the second one is at least findable. Whoever next has reason to touch either should renumber one
and fix its inbound links. **Claim the next free number by looking at `docs/adr/`, not at this
table** — the table can lag by a commit.

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
| 4   | Rust vs. C++ for the sidecar — how mature are the WGC / ScreenCaptureKit bindings really?                              | During the CV spike                                       |
| 5   | Where does the agent's prompt/persona live? Proposal: versioned files in `packages/context/prompts/` with golden tests | With `packages/context`                                   |
| 6   | Anti-cheat: is a global hook plus an always-on-top window viable?                                                      | **Blocking** — before any UI is built on the hotkey layer |
| 7   | Does the Realtime session get its own hidden window, or does the overlay host it? ([ADR-0010](adr/0010-dedicated-voice-window.md), Proposed) | With `packages/realtime`                                  |
| 8   | Who scrubs other players' chat before it can reach an on-screen caption?                                               | Before caption mode ships                                 |
| 9   | May consent for `read_screen` be remembered for a match, or is it per call? Per call is the default until someone decides otherwise | Before `read_screen` ships                                |
| 10  | Can the Realtime API emit more than one function call per response? It decides whether the command queue needs to exist at all | Before `packages/context/src/tools/queue.ts` is written   |

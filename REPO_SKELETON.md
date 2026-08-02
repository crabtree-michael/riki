# Riki — Repository Skeleton Proposal

**Status:** Scaffolded. The layout, gates, and configuration described here exist in the repo;
the packages and crates are skeletons awaiting the work in §10 steps 2 onward.
**Scope:** Directory layout, testing strategy, linting and code-quality gates, environment
configuration, and the build/dev workflow for the Riki codebase.
**Out of scope:** Product design (see [`docs/design/ui-design.md`](docs/design/ui-design.md)),
state capture architecture (see
[`docs/design/dota2-state-capture-design.md`](docs/design/dota2-state-capture-design.md)),
and the Realtime API integration decision (see
[`docs/research/openai-realtime-research.md`](docs/research/openai-realtime-research.md)).

This document is written for the agents who will build Riki. Read §1 and §2 to know where your
work goes, §5 to know what "tested" means here, §9 for the definition of done, and §13 for the
skills that carry this knowledge into a task without anyone having to reopen this file.

---

## 0. Assumptions

The repo is currently docs-only, so the layout is derived from the three design documents rather
than from existing code. Sections marked ⚑ change if an assumption is wrong.

| # | Assumption | Source | Affects |
|---|---|---|---|
| A1 | Riki is a desktop app: overlay chip + tray + voice, running alongside Dota 2 | `ui-design.md` §2 | ⚑ §1 Stack |
| A2 | WebRTC is the Realtime transport, which means a Chromium-class renderer owns the mic | `openai-realtime-research.md` §2, §11.5 (AEC is mandatory) | ⚑ §1 Stack |
| A3 | Capture + CV must be a **separate process**, perf-budgeted, and must not take the app down when it crashes | `dota2-state-capture-design.md` §3, §9 | ⚑ §2 `crates/` |
| A4 | During alpha/beta, each developer supplies their own OpenAI API key via `RIKI_OPENAI_API_KEY` in a local `.env`. No minting service, no backend. | this document, §7 | ⚑ §7 config, §11.2 |
| A5 | Multiple agents work in parallel and commit directly to `main` | `AGENTS.md` | ⚑ §2 ownership, §8 CI |
| A6 | Agents cannot run Dota 2, cannot use a real microphone, and should not spend money on live Realtime sessions | — | ⚑ §5 (fixtures/replay are load-bearing) |

**A6 is the one that shapes the most.** If the test suite needs a running game client, agents
cannot verify their own work, and every task ends with "untested, please check." The whole
fixture-and-replay apparatus in §5.2 exists to make that impossible.

**A4 is deliberately temporary.** `openai-realtime-research.md` §9 is right that an API key cannot
ship inside a distributed binary — but nothing is being distributed yet. For alpha and beta the
audience is the people building Riki, who need direct key access anyway, so the key comes from the
developer's own environment. What replaces it at distribution time is an open question (§11.2), not
a solved one; the code just has to keep that swap cheap. See §7.

---

## 1. Stack

One decision up front, because the directory layout is downstream of it.

**Electron (TypeScript) for the shell, voice, and world model; Rust for the capture/CV sidecar.
No backend** — per A4 the API key comes from the developer's environment.

| Layer | Choice | Why |
|---|---|---|
| Shell / overlay / tray / hotkeys | **Electron + TypeScript** | The overlay is a click-through layered window with per-pixel alpha (`ui-design.md` §6.5) — a normal desktop window concern. Electron bundles Chromium, which is the only route that gives us WebRTC *and* known-good acoustic echo cancellation. AEC is not optional: `openai-realtime-research.md` §11.5 documents self-interruption loops as a reliable failure without it. Tauri's webview-per-OS AEC variance (§9 of the same doc) is exactly the risk we cannot absorb. |
| GSI server, world model, context, events | **TypeScript, in the Electron main process** | `dota2-state-capture-design.md` §3: "the GSI server and world model are lightweight enough to share the main process." Inputs arrive at 2–8 Hz. This is not hot code. |
| Capture + CV | **Rust, separate process** | Budget is ≤3% of one core with no measurable FPS delta (`dota2-state-capture-design.md` §1). That rules out Node and Python for the shipping path. Rust also gives clean bindings to ScreenCaptureKit / PipeWire / WGC — ScreenCaptureKit first, since macOS is the primary target (`ui-design.md` A3). |
| API credentials | **`RIKI_OPENAI_API_KEY` from the environment** | Alpha/beta only (A4). Resolved by `packages/config` in the Electron **main** process and injected into `packages/realtime`; it never crosses the preload bridge into the renderer. No service to run, deploy, or authenticate against. |

Alternatives and why not: pure Python (cannot meet the CV budget, no good overlay story); pure
Rust/Tauri (AEC variance, more work, per A2); a web app (no overlay, no global hotkeys).

---

## 2. Directory layout

```
riki/
├── AGENTS.md                        how agents work here — read first
├── README.md
├── REPO_SKELETON.md                 this file
├── CONTRIBUTING.md                  human-facing setup + workflow
│
├── package.json                     pnpm workspace root; canonical script names (§7)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js                 flat config, incl. module-boundary rules (§6.2)
├── .prettierrc  .editorconfig  .markdownlint.jsonc
├── vitest.workspace.ts
├── Cargo.toml                       Rust workspace
├── rustfmt.toml  clippy.toml  deny.toml
├── lefthook.yml                     git hooks
├── .env.example                     every var, documented, no real values (§7)
├── .gitattributes                   LFS rules for fixture frames
├── .gitignore
│
├── .claude/
│   ├── settings.json                marketplaces + enabled plugins, project scope
│   └── skills/                      one skill per area — living practice, not spec (§13)
│       └── <area>/SKILL.md
│
│   (no .github/ — there is no CI; the gate is lefthook's pre-commit, §8.2 and ADR-0008)
│
├── apps/
│   └── desktop/                     the Electron application
│       ├── src/
│       │   ├── main/                lifecycle, tray, global hotkeys, window mgmt,
│       │   │                        sidecar supervisor, IPC host
│       │   ├── preload/             the only bridge; contextIsolation on, no node in renderer
│       │   ├── renderer/
│       │   │   ├── overlay/         the chip — states, motion, bars (ui-design §3–§5)
│       │   │   ├── settings/        settings surface (ui-design §11)
│       │   │   └── onboarding/      first-run consent, GSI setup, hotkey capture check
│       │   └── shared/              types shared across main↔renderer only
│       ├── resources/               tray glyphs, earcon audio, atlases
│       ├── test/                    integration tests (main-process, no window)
│       └── e2e/                     Playwright-driven Electron tests
│
├── packages/                        TypeScript libraries — the testable core
│   ├── protocol/                    ⭐ THE CONTRACT. zod schemas for every cross-boundary
│   │                                message + generated JSON Schema + generated Rust types.
│   │                                Changing this changes two languages — see §4.
│   ├── config/                      layered config resolution + validation. The ONLY place
│   │                                that reads process.env — including the API key (§6.2, §7)
│   ├── gsi/                         GSI HTTP listener, auth, parsing, liveness/heartbeat
│   ├── log-tail/                    console.log tailer: chat, kill feed, rotation handling
│   ├── world-model/                 the model, fusion, provenance, staleness, confidence,
│   │                                derived state, ring history (dota2 §4)
│   ├── context/                     session preamble, rolling snapshot, coaching brief,
│   │                                memory layer (dota2 §6, coaching §4–§5)
│   ├── events/                      event engine, salience scoring, trigger policy,
│   │                                interrupt gates (dota2 §6.4, coaching-trigger)
│   ├── realtime/                    OpenAI Realtime session: transport, event bus, barge-in,
│   │                                truncation policy, cost accounting
│   ├── audio/                       device enumeration, RMS/envelope for the bars, resampling,
│   │                                earcons, ducking
│   └── telemetry/                   structured logging, perf counters, redaction rules
│
├── crates/                          Rust — the sidecar
│   ├── riki-vision/                 the sidecar binary: supervisor-friendly, stdio protocol
│   ├── riki-capture/                ScreenCaptureKit (mac) · PipeWire portal (linux) · WGC (win)
│   │                                GPU crop, downscale, region hashing
│   ├── riki-cv/                     calibration, digit/icon template matching, minimap
│   │                                detection, confidence scoring
│   └── riki-ipc/                    sidecar side of packages/protocol (generated + handwritten)
│
├── fixtures/                        ⭐ what makes the repo workable without a game running
│   ├── gsi/                         recorded GSI sessions, JSONL, one line per POST + ts
│   ├── console-log/                 captured console.log excerpts
│   ├── frames/                      hand-labelled screenshots + label JSON (git-lfs)
│   ├── realtime/                    recorded Realtime event transcripts for replay
│   └── golden/                      expected snapshot-renderer output
│
├── tools/                           dev-only executables, not shipped
│   ├── gsi-replay/                  replay a fixture session into a running dev build
│   ├── gsi-record/                  capture a live session to a fixture
│   ├── frame-labeler/               annotate frames for the CV corpus
│   ├── atlas-build/                 build hero/item/digit template atlases per HUD scale
│   └── setup-gsi-cfg/               write the gamestate_integration cfg + per-install token
│
├── bench/
│   ├── cv/                          criterion benchmarks, thresholds enforced in CI
│   └── frametime/                   Dota 1% low harness — manual, real hardware, release gate
│
├── docs/
│   ├── README.md                    index: what's here, what's decided, what's open
│   ├── design/                      ui-design.md, dota2-state-capture-design.md  (moved)
│   ├── research/                    openai-realtime-research.md  (moved)
│   ├── adr/                         numbered decision records, ADR-0001 onward
│   └── runbooks/                    dev setup, releasing, on-call-ish troubleshooting
│
└── scripts/                         repo chores: codegen, fixture fetch, release
```

### 2.1 Why this shape

**One package per concern in `dota2-state-capture-design.md` §3.** The architecture diagram in
that doc has named boxes — GSI server, capture+CV, log tailer, fusion, world model, event
engine, context builder, trigger policy. Each becomes its own package or crate. That is not
decoration: per A5, agents work in parallel and commit to `main` without review, so the cheapest
way to avoid collisions is for two agents' tasks to touch disjoint directories.

**`packages/protocol` is deliberately small and deliberately central.** It is the one place two
agents *will* collide, so it gets the strictest rules (§4).

**Business logic lives in `packages/`, not in `apps/desktop`.** The world model, snapshot
renderer, and salience scoring are pure functions over data. Kept out of Electron they are
testable in milliseconds with no window, no game, and no GPU. `apps/desktop` should end up thin:
wiring, windows, and platform calls.

**`fixtures/` is a first-class directory, not a test subfolder.** Multiple packages, both
languages, and the dev tools all read from it.

**Every `packages/*` manifest exports the same three conditions per subpath** —
[ADR-0025](docs/adr/0025-packages-export-source-to-the-toolchain.md):

```jsonc
"exports": {
  ".": {
    "riki-source": "./src/index.ts",  // Vitest, via resolve.conditions
    "types": "./src/index.ts",        // tsc and eslint-import-resolver-typescript
    "default": "./dist/index.js"      // Node, and therefore Electron main
  }
}
```

Tests and typecheck run against the working tree with no build step; Node runs the compiled output,
because Node cannot execute TypeScript and `src/index.ts` importing `./common/timers.js` resolves
to a file that only `tsc --build` creates. **If you add a package, copy this shape** — a plain
`"./src/index.ts"` string works everywhere until the first time something tries to `require` or
`import` it at runtime, which is `pnpm dev` and nothing earlier.

### 2.2 Ownership map — where does my task go?

| If your task is about… | Work in | Spec |
|---|---|---|
| The chip, its states, motion, colours | `apps/desktop/src/renderer/overlay` | ui-design §3–§5 |
| Tray icon, menu, mute | `apps/desktop/src/main` | ui-design §2.3 |
| Global hotkey, tap-vs-hold, conflict detection | `apps/desktop/src/main` | ui-design §6 |
| Receiving GSI POSTs | `packages/gsi` | dota2 §2.1 |
| Chat / kill feed from `console.log` | `packages/log-tail` | dota2 §2.3 |
| Merging sources, staleness, confidence | `packages/world-model` | dota2 §4 |
| The ~300-token snapshot the LLM sees | `packages/context` | dota2 §6.2 |
| The coaching brief the LLM is given for one moment | `packages/context/src/coaching` | coaching §4–§5 |
| What Riki coaches on, and when | `packages/events` | coaching-trigger, dota2 §6.4 |
| Wiring events → context → realtime | `apps/desktop/src/main/agent` | coaching §9.3 |
| Realtime session, barge-in, truncation | `packages/realtime` | realtime §2, §4, §5 |
| Mic level, earcons, ducking, resampling | `packages/audio` | ui-design §7, realtime §3 |
| Screen capture, calibration, minimap CV | `crates/riki-*` | dota2 §2.2 |
| API key resolution, `.env` handling | `packages/config` | §7 |
| Authenticating a Realtime session with the key | `packages/realtime` | realtime §6 |
| Anything crossing TS↔Rust | `packages/protocol` **first** | §4 |

---

## 3. Documentation structure

`docs/` already holds the design corpus and `AGENTS.md` names it as the home for durable
reasoning. Three changes:

1. **Split by kind** — `design/` (how it should work), `research/` (what we learned about the
   outside world), `adr/` (what we decided and why), `runbooks/` (how to do a thing).
2. **Add `docs/adr/`.** The existing docs already make binding calls — push-to-talk by default,
   no red, read-only observation only, Electron over Tauri — but they bury them in long
   documents. An ADR is one page: context, decision, consequences, status. Agents get a
   scannable list of what is already settled instead of re-litigating it. Seed with:
   ADR-0001 Electron shell · ADR-0002 WebRTC transport · ADR-0003 read-only observation only ·
   ADR-0004 push-to-talk default · ADR-0005 monorepo + protocol package ·
   ADR-0006 env-var API key for alpha/beta, no minting service (§7.1, superseded when §11.2 is
   decided — an ADR with a `Status` field is how that gets recorded rather than silently reversed).
3. **`docs/README.md` as the index** — what exists, what is decided, what is open. The open
   questions currently sit at the bottom of three separate documents where nobody finds them.

House style is already set by the existing docs and should hold: state assumptions up front,
mark the ones that are load-bearing, record rejected alternatives so they are not re-proposed.

**`docs/` is not the only place knowledge lives.** A document has to be opened to help
anyone, and an agent dispatched into `packages/events` will not open this one. Skills —
`.claude/skills/`, §13 — carry the same knowledge into the task automatically. Everything in
this section still holds; §13 covers the part that `docs/` structurally cannot.

---

## 4. The protocol package — rules

`packages/protocol` defines every message crossing a process or language boundary: Electron main
↔ renderer, and Electron ↔ Rust sidecar.

- **zod is the source of truth.** JSON Schema is generated from it; Rust types are generated from
  that JSON Schema into `crates/riki-ipc`. Generation runs in `pnpm codegen` and CI fails if the
  generated files are dirty. Hand-editing generated Rust is the failure mode to prevent.
- **Every message is versioned.** The sidecar and the app can be different builds during
  development; a version mismatch must produce a clear error, not a confusing parse failure.
- **Confidence, provenance, and timestamps are non-optional fields** on every CV-derived fact.
  `dota2-state-capture-design.md` §4 makes these structural, and the type system should too — a
  CV position that can be constructed without a confidence score will eventually be rendered to
  the agent as if it were a fact, which §4 rule 3 calls out as the worst outcome in the product.
- **Changing protocol is a coordination event.** Say so in the commit message; other agents may
  be mid-task against the old shape.

---

## 5. Testing

### 5.1 Frameworks

| Target | Tool | Notes |
|---|---|---|
| TypeScript unit + integration | **Vitest** | Workspace mode, one project per package. Fast, ESM-native, snapshot support built in. |
| Electron end-to-end | **Playwright** (`_electron`) | Drives a real Electron build; the only place a window is launched. |
| Rust unit + integration | **`cargo test`** | Plus **`insta`** for CV snapshot assertions. |
| Rust benchmarks | **criterion** | Thresholds enforced (§5.6). |
| Contract (TS↔Rust) | Vitest + `cargo test` over shared fixtures | §5.4. |
| Coverage | `vitest --coverage` (v8), `cargo-llvm-cov` | Reported, not gated at a blanket number — see §5.7. |

Tests live colocated as `*.test.ts` next to the unit under test; integration and e2e tests get
their own `test/` and `e2e/` directories. Rust follows the standard `#[cfg(test)]` /
`tests/` split.

### 5.2 The rule that matters most

> **No test may require a running Dota 2 client, a real microphone, a GPU, or a live OpenAI
> session.** Every external input has a fixture and a fake.

Per A6 this is what lets an agent finish a task and actually verify it. It also keeps CI free and
deterministic. Concretely, four fakes ship as `testing/` subpath exports so any package can
import them:

| Fake | Replaces | Behaviour |
|---|---|---|
| `FakeGsiSource` | The Dota client's POSTs | Replays `fixtures/gsi/*.jsonl` at recorded or accelerated wall-clock timing |
| `FakeVisionSidecar` | The Rust process | Emits scripted protocol messages, including crashes, stalls, and low-confidence output |
| `FakeRealtimeTransport` | OpenAI | Replays `fixtures/realtime/*`; records what we sent for assertion; can inject errors and mid-response disconnects |
| `FakeAudioDevice` | Mic + speakers | Feeds known PCM, captures output for the resampling tests |

The fakes are not test scaffolding — they are also what `pnpm dev:replay` (§7) uses, so a
developer or agent can drive the whole app with no game installed. Keeping them shared means
they stay honest.

### 5.3 Test tiers

**Tier 1 — unit (the bulk).** Pure functions, no I/O, milliseconds. Fusion precedence
(GSI beats CV, CV never overwrites fresh GSI), staleness decay, derived state arithmetic
(gold-to-item, buyback affordability, Roshan window), snapshot token budgeting and priority
truncation, salience scoring, cooldown and novelty gates, calibration solve, template match
scoring, audio RMS and envelope math.

**Tier 2 — golden.** Committed expected outputs, reviewed as diffs.

- Snapshot renderer → `fixtures/golden/`. Format changes should show up as a readable diff,
  because the format *is* the interface to the LLM.
- CV detections → `insta` snapshots against `fixtures/frames/`, with an **F1 floor** rather than
  exact equality. `dota2-state-capture-design.md` §10.3 names minimap accuracy as the
  load-bearing assumption of the entire vision layer; it needs a number in CI, not a vibe.

**Tier 3 — contract.** Both languages parse the same `fixtures/protocol/` corpus and must agree.
Round-trip: TS encodes → Rust decodes → Rust re-encodes → TS decodes → deep-equal. This is the
cheapest insurance against the most likely cross-language bug.

**Tier 4 — integration.** Replay a full recorded match through
GSI → fusion → world model → derived → snapshot, with a fake sidecar injecting CV facts.
Assert the latency budgets (GSI POST → model < 10 ms; model → snapshot < 5 ms) and the
failure-mode table in dota2 §9 (heartbeat miss → CV-only + user notice; sidecar crash → restart with
backoff; pause → freeze and mark stale).

**Tier 5 — end-to-end.** Playwright on a real Electron build. State machine transitions from
`ui-design.md` §3.1 including barge-in and Esc-cancel; the **≤100 ms key-down → chip visible**
budget from §8; that Hidden renders no window at all (§10 "idle costs literally nothing");
reduced-motion and high-contrast variants; the caption-mode-off-by-default default.

**Tier 6 — performance.** §5.6.

### 5.4 Specific tests the specs have already asked for

The design docs name failure modes precisely enough to write the guarding test now. These are
not optional extras; each one guards something a doc flags as high-risk.

| Risk (source) | Guarding test |
|---|---|
| Beta/GA schema mixing silently misconfigures the session (realtime §3) | Assert the outgoing `session.update` matches the GA schema exactly and contains **no** top-level `voice` or string `input_audio_format`. Snapshot it. |
| Wrong resampling produces pitch-shifted audio rather than an error (realtime §3) | Round-trip 48 kHz → 24 kHz → 48 kHz on a known tone; assert frequency within tolerance. The doc explicitly asks for this test. |
| Barge-in without `conversation.item.truncate` corrupts every later turn (realtime §4) | On simulated interruption, assert a truncate event was sent with a plausible `audio_end_ms`. |
| Context fills in 15–20 min and truncates oldest-first (realtime §5) | Simulate a 25-minute session; assert the retention policy fires and cache-busting truncations stay under a threshold. |
| Stale CV facts rendered as certainties (dota2 §4, §6.2) | Feed a 30-second-old CV position; assert the snapshot renders it with an age and confidence marker and never as a bare fact. |
| Confidence below threshold surfaced anyway (dota2 §4) | Below-threshold facts are dropped, not rendered. |
| Riki talks over the player or during a fight (dota2 §6.4) | Trigger policy suppresses under simulated teamfight conditions and while the player is speaking. |
| Red used for errors (ui-design §4.2) | Token lint: no `#FF0000`-family value in the accent palette. |
| Colour as the only channel (ui-design §4.3) | Every state has a distinct glyph and motion signature; assert exhaustively over the state enum. |
| Chat text leaving the machine by default (dota2 §7) | Egress test: with default config, assert chat text never reaches the outbound payload. |
| Voice chat captured (dota2 §7) | Assert no capture path exists for game audio output. |
| API key baked into a build artifact (realtime §9) | Build-artifact scan for key-shaped strings. The key is only ever read from the environment at runtime by `packages/config`, so a key in a bundle means someone hardcoded one. |
| API key reaching the renderer, a log, or a crash report (§7) | Assert the key is absent from the preload bridge surface and from anything `packages/telemetry` emits — the redaction rules cover it like chat text. Assert `packages/realtime` receives it injected and never reads `process.env` itself. |
| A developer commits their `.env` | gitleaks (§6.1) plus an explicit `.gitignore` entry; a test asserts `.env` is ignored, since the whole scheme rests on that one line. |
| Missing key degrades badly instead of cleanly (§7.1) | With `RIKI_OPENAI_API_KEY` unset, assert the app boots, reports voice as unavailable, and `pnpm dev:replay` still runs end to end. This is the state CI itself runs in, so a regression shows up immediately. |

### 5.5 What is genuinely hard to test, and what we do instead

Honesty matters more than coverage theatre:

- **Anti-cheat interaction** (`ui-design.md` §13.3, flagged as a blocking risk) cannot be unit
  tested. It needs a manual spike against EAC/BattlEye/Vanguard, documented in
  `docs/runbooks/anticheat-validation.md`, before UI is built on the hotkey layer.
- **Real CV accuracy in a chaotic teamfight** is bounded by the quality of `fixtures/frames/`.
  The corpus needs to grow deliberately, weighted toward hard frames, not easy ones.
- **Perceived latency and whether Riki is annoying** are human judgements. `bench/frametime`
  and real-user tuning, not CI.
- **Exclusive fullscreen capture** behaviour differs per title and cannot be faked.

Each of these gets a runbook rather than a test, and the runbook result gets committed.

### 5.6 Performance testing

Two separate things, often conflated:

1. **Micro-benchmarks (CI-gated).** criterion over `crates/riki-cv`: region hash, template match,
   minimap pass, calibration solve. A regression threshold fails the build. Cheap, catches the
   obvious.
2. **Frame-time harness (manual, release gate).** The metric that matters is **Dota's 1% low
   frame time with Riki running versus not**, on a low-end machine, at 1080p/1440p/4K. This cannot run in CI. It runs on real hardware before a
   release and the numbers get committed to `docs/runbooks/perf-results/`. A release that has not
   run it is not a release.

### 5.7 On coverage

Reported per package, not gated at a blanket percentage. A uniform threshold pushes agents toward
testing `apps/desktop` wiring, which is the least valuable code in the repo. Where a floor is
useful is `packages/world-model`, `packages/context`, and `packages/events` — pure logic, cheap
to test, and where a silent bug becomes wrong advice in a player's ear. Propose 85% there and
report-only elsewhere.

---

## 6. Linting and code quality

### 6.1 Tooling

| Concern | Tool | Gate |
|---|---|---|
| TS lint | **ESLint** flat config + `typescript-eslint` `strict-type-checked` | error |
| TS types | `tsc --build` over the project references | error |
| Formatting (TS/JSON/MD/YAML) | **Prettier** | error (`--check` in CI) |
| Rust format | **rustfmt** | error |
| Rust lint | **clippy** with `-D warnings` | error |
| Rust deps | **cargo-deny** — licences, advisories, duplicate versions | error |
| JS deps | `pnpm audit` + lockfile freshness | warn → error on advisories |
| Secrets | **gitleaks** | error |
| Markdown | **markdownlint** + **lychee** link check | error / warn |
| Commit hygiene | **lefthook** — format + lint changed files pre-commit | local |

Two tools, one per language, doing formatting and linting. No Biome-plus-ESLint-plus-Prettier
sprawl; agents should not have to work out which formatter owns a file.

**One narrowing, decided during scaffolding: Prettier does not format markdown.** `*.md` is in
`.prettierignore` and markdownlint owns it alone. Prettier pads every table cell to the widest
row, which turns the wide tables throughout these docs into 700-column lines, and reflowing
prose someone else hand-wrapped produces large diffs that collide with agents working in the
same file. One tool still owns markdown, so the rule above still holds. The rationale is
repeated in `.prettierignore` so nobody re-adds it.

### 6.2 Rules that encode design decisions

Ordinary lint rules catch ordinary mistakes. These catch the specific things the design docs say
must not happen, and they are worth the setup cost because they hold without anyone remembering:

- **Module boundaries** (`eslint-plugin-boundaries`):
  - `packages/*` may not import from `apps/*`. Business logic stays testable.
  - The `openai` SDK may only be imported by `packages/realtime`.
  - `packages/world-model` may not import `packages/realtime` — the model must not know it is
    feeding an LLM (`dota2-state-capture-design.md` §1: state and conversation rates are
    decoupled by design).
  - Renderer code may not import from `main/`; the preload bridge is the only path.
- **`process.env` is readable only in `packages/config`.** Everything else takes injected config.
  This is what makes config testable and keeps secrets traceable to one file. It matters more now
  that the API key arrives by environment variable (§7): one file to audit, and one file to change
  when the key stops coming from `.env`.
- **No `console.*` outside `packages/telemetry`.** Logs pass through redaction (chat text and
  Steam IDs, per `dota2-state-capture-design.md` §7) before they reach a sink.
- **No raw colour literals in renderer code** — accents come from the token module in
  `ui-design.md` §4.2, so the "no red" rule has exactly one place to be enforced.
- **`no-floating-promises` and `no-misused-promises` as errors.** The Realtime integration is an
  async event bus (`openai-realtime-research.md` §1); a dropped promise there manifests as a
  hung session, which is the hardest class of bug to reproduce here.

---

## 7. Environment configuration

**Layered resolution**, highest wins: CLI flags → environment → user config file (OS config dir:
`%APPDATA%\Riki`, `~/.config/riki`) → committed defaults. Resolved once at startup by
`packages/config`, validated with zod, and **injected** thereafter.

Invalid config fails at startup with a readable message naming the offending key. It never
half-boots — a Riki that runs with a broken microphone setting and no error is exactly the
failure `ui-design.md` §1.6 says to avoid.

### 7.1 The API key

**Alpha and beta use a plain environment variable.** Every developer brings their own OpenAI key:

```bash
cp .env.example .env
# then edit .env and set RIKI_OPENAI_API_KEY=sk-...
```

That is the whole setup. `pnpm setup` (§8.1) creates `.env` from the example if it is missing and
prints the one line you still have to fill in. `packages/config` loads `.env` at startup.

The key is **conditionally required**: absent, the app boots fine with voice disabled and says so
in the UI — that is the mode fixtures, tests, and CI run in. Present but malformed, or absent when
something asks for a live session, fails loudly with a message naming the variable and pointing at
this section. What must not happen is discovering it on the first Realtime connection attempt, ten
minutes into a game.

Rules that come with it, all of them cheap:

- **`.env` is gitignored, `.env.example` is committed.** The example carries every variable with
  documentation and no real values. gitleaks (§6.1) is the backstop, but the `.gitignore` line is
  the actual protection and §5.4 tests that it is there.
- **The key is read in exactly one place** — `packages/config`, in the Electron **main** process —
  and injected into `packages/realtime`. It does not cross the preload bridge, so the renderer
  never sees it, and it is redacted by `packages/telemetry` alongside chat text and Steam IDs.
- **Anything that costs money needs a real key, so it is not in the gate.** Per §5.2 no test may
  require a live OpenAI session; `FakeRealtimeTransport` covers the rest. The pre-commit gate runs
  with the variable unset, which means an agent's commit succeeds on a machine with no key at all.
- **`pnpm dev:replay` needs no key either.** Fixtures drive the whole app. A key is only needed to
  talk to a live model.

This is a development-time arrangement, and it stops being adequate the moment Riki is distributed
to someone who is not building it — see §11.2. Keeping the key confined to `packages/config` is
what makes that later swap a one-file change.

### 7.2 `.env.example`

Committed with every variable documented and no real values:

```bash
# --- OpenAI (alpha/beta: your own key, your own .env — see §7.1) ---
RIKI_OPENAI_API_KEY=            # your own key. Required only for live voice; leave blank to
                                # run fixtures-only. Read by packages/config in the main
                                # process and nowhere else. Never commit a filled-in .env.

# --- Realtime ---
RIKI_REALTIME_MODEL=gpt-realtime-2.1-mini   # mini by default; cost lever, realtime §10
RIKI_REALTIME_VOICE=marin
RIKI_REALTIME_TRANSPORT=webrtc              # webrtc | websocket

# --- Dota integration ---
RIKI_GSI_PORT=53101
RIKI_GSI_TOKEN=                 # generated per-install by tools/setup-gsi-cfg; not a secret
                                # to share across machines, but never committed
RIKI_DOTA_PATH=                 # auto-detected; override for non-standard Steam installs

# --- Feature flags / degradation ---
RIKI_VISION=off                 # on | off — off runs GSI-only (dota2 §9 fallback path).
                                # Off until a platform capture backend exists (ADR-0030)
RIKI_UNPROMPTED=off             # on | off — "only when I ask" mode, dota2 §6.4
RIKI_CAPTIONS=off               # must default off, ui-design §9.3
RIKI_LOG_LEVEL=info

# --- Development ---
RIKI_REPLAY_FIXTURE=            # path to a fixtures/gsi/*.jsonl to drive a dev session
RIKI_FAKE_VISION=0              # 1 → FakeVisionSidecar instead of the Rust process
```

`.env.example` is the file, not this block: it has grown the audio, log-tail, privacy and
hotkey variables since this was written, and each one is documented there. Three rules:

1. **Secrets stay in `.env` and in one module.** `RIKI_OPENAI_API_KEY` is read by
   `packages/config` only, never hardcoded and never committed; a lint boundary, gitleaks, and a
   build-artifact scan enforce it (§5.4, §6.2).
2. **Privacy-relevant defaults are off**, and their defaults are asserted by tests, not just
   written down: captions off, unprompted speech off, chat egress off, debug frame capture off.
3. **The GSI token is generated per install**, matching the cfg template in
   `dota2-state-capture-design.md` §2.1, and written by `tools/setup-gsi-cfg`.

---

## 8. Build, dev, and CI workflow

### 8.1 Canonical scripts

One name per action, from the repo root. If a command is not here, it should be.

| Command | Does |
|---|---|
| `pnpm install` | Node deps. `cargo build` is invoked by the dev/build scripts. |
| `pnpm setup` | Install deps, fetch LFS fixtures, generate protocol types, install hooks, create `.env` from `.env.example` if absent. **One command for a fresh clone.** |
| `pnpm dev` | Launches the Electron app: `tsc --build`, copy the renderer's assets, `electron .`. **No Vite HMR and no `cargo watch` yet** — the renderer is three hand-written ES modules and the sidecar does nothing, so neither has earned a watcher. Configuration is `packages/config`'s: CLI flags → `RIKI_*` → `.env` (searched upward from the working directory, so the repo root's is found) → `settings.json` under the app's data directory → defaults. |
| `pnpm dev:replay` | `pnpm dev` with `FakeGsiSource` + `FakeVisionSidecar` driving a fixture. **No Dota and no API key required.** |
| `pnpm test` | Vitest + `cargo test`. No game, no network, no GPU, no API key. |
| `pnpm test:e2e` | Playwright against a built Electron app |
| `pnpm lint` | ESLint + markdownlint + clippy. **Not gitleaks** — the hooks run that (§6.1, §8.2). |
| `pnpm format` / `pnpm format:check` | Prettier + rustfmt |
| `pnpm typecheck` | `tsc --build --force` over the project references. Not `--noEmit`: the packages are `composite`, which requires emit. |
| `pnpm codegen` / `pnpm codegen:check` | Regenerate JSON Schema + Rust types from `packages/protocol`; `:check` fails on a diff |
| `pnpm check:skills` | ⚠ **Not implemented.** Designed in §13.7; no script exists and `pnpm check` does not call it. |
| `pnpm bench` | criterion micro-benchmarks |
| `pnpm check` | **lint + format:check + typecheck + test + codegen:check.** Run before committing. |
| `pnpm build` | Production build of app + sidecar |

`pnpm check` is the same set of checks the pre-commit hook runs (§8.2), so running it by hand is
how you see the verdict before `git commit` does. The hook is what actually enforces it.

One caveat, which costs an agent time if discovered late: **`pnpm check` is green on a machine
with no Rust toolchain**, because the cargo steps skip with a `[cargo] skipped …` notice rather
than failing (`scripts/cargo.mjs`). That is deliberate — TypeScript-only work should not require
rustup — but it means a green check does not by itself mean the Rust side compiled, and with no
CI there is no second opinion. Read the output.

**Four of these are stubs.** `dev`, `dev:replay`, `test:e2e` and `build` currently run
`scripts/not-scaffolded.mjs`, which exits with a pointer to the §10 step that will implement
them. The rows above describe what they will do, not what they do today.

### 8.2 The gate: pre-commit, not CI

**There is no CI.** No GitHub Actions, no `.github/` directory. The full gate runs locally on
**pre-commit**, defined in `lefthook.yml`. The reasoning is ADR-0008; the short version is that
agents are the primary contributors, and a failure reported to a cloud log after the agent has
finished is a failure with no reader.

What runs on every commit, in order, stopping at the first failure:

| # | Step | Scope |
|---|---|---|
| 01–03 | prettier · eslint · rustfmt, with `--fix` | staged files, re-staged after fixing |
| 04–06 | `prettier --check` · `lint:ts` · `lint:md` | whole repo |
| 07–09 | `typecheck` · `test:ts` · `codegen:check` | whole repo |
| 10 | gitleaks | staged diff |
| 11–12 | `rustfmt --check` · clippy · `cargo test` · cargo-deny | only if the commit touches `crates/`, `Cargo.*` or the Rust config |
| 13 | lychee link check — **warn only**, skips if not installed | markdown |

Roughly 8s for a TypeScript commit; the same for a Rust one once cargo is warm.

`pre-push` keeps two things that only make sense there: the LFS object upload (§8.3) and a
full-history gitleaks scan as a backstop.

**Bypassing is blocked, not discouraged.** Since pre-commit is the only enforcement,
`scripts/block-no-verify.mjs` runs as a Claude Code `PreToolUse` hook (`.claude/settings.json`)
and refuses `--no-verify`, `git commit -n`, `core.hooksPath` overrides and `LEFTHOOK=0`. It
covers agents, which is the point; it cannot bind a human at a terminal, and no client-side hook
can.

**What this gives up.** The deleted `ci.yml` ran a `ubuntu-latest` + `windows-latest` matrix —
which was already aimed at the wrong platform, since macOS is the shipping target
(`ui-design.md` A3) and §2.1 of `dota2-state-capture-design.md` flags Linux/Proton GSI as
historically buggy. Platform divergence will now surface in a bug report rather than a red build.
Nothing compiles per-platform yet, so the loss is theoretical until `crates/riki-capture` grows a
ScreenCaptureKit backend — at which point it stops being theoretical fast, because that backend
cannot be compiled on the Linux dev box at all. **If CI comes back, it should come back for a
`macos-latest` job specifically**, plus the e2e and bench jobs that cannot run per-commit — not
to duplicate what pre-commit already covers.

### 8.3 Fixture management

Recorded frames are binary and large; JSONL fixtures are small and diff well.

- `fixtures/frames/**` via **git-lfs**, configured in `.gitattributes`.
- Everything else committed plainly — a GSI recording of a full match is a few MB of JSONL and is
  worth having in normal git history so diffs are reviewable.
- `pnpm setup` fetches LFS objects; tests that need frames skip with a clear message if the
  objects are absent, rather than failing cryptically.

---

## 9. Working agreements for agents

Extends `AGENTS.md` rather than replacing it.

**Before you start**

- Read the spec section for your area (§2.2 has the mapping).
- Skim your area's skill in `.claude/skills/` (§13.3). It should already have loaded; it is
  shorter than the spec and it carries what previous agents got wrong.
- Check `docs/adr/` — the decision may already be made.
- `git pull`. Others commit to `main` while you work.

**While you work**

- Stay in your directory. If your task needs a change in someone else's package, that is usually a
  sign the seam is in the wrong place — say so in your report rather than reaching across.
- Touching `packages/protocol` is a coordination event (§4). Say so loudly.
- Add the fixture alongside the code. A parser without a fixture is untestable by the next agent.

**Before you commit**

- `pnpm check` passes.
- New behaviour has a test at the lowest tier that can catch it (§5.3).
- If you added a design decision, it is an ADR — not a comment.
- If you learned something that would have saved you time at the start, it is in your area's
  skill, in this commit (§13.5).
- If you left something undone, the commit message says what and why (`AGENTS.md`).

**Definition of done:** the work is on `main`, `pnpm check` is green, the behaviour is covered by
a test that runs without Dota 2 or a live API, and anything you learned that the next agent needs
is written down where they will hit it — `docs/` for reasoning, the area's skill for practice.

---

## 10. Suggested scaffolding order

`dota2-state-capture-design.md` §11 gives a build order for the product. This is the
infrastructure order that unblocks it, front-loaded so agents are productive immediately.

| # | Step | Unblocks |
|---|---|---|
| 1 | Workspace root: pnpm + Cargo, tsconfig, ESLint, Prettier, rustfmt, clippy, lefthook, `pnpm check`, `check:skills`, CI | Everything. Nothing else should land before the gates exist. **Landed except `check:skills` (§13.7) and activating CI (§8.2)** — both still open. |
| 2 | `packages/protocol` + `pnpm codegen` + contract test harness | Any cross-boundary work. **Landed for the sidecar boundary.** zod → JSON Schema → Rust is implemented in `scripts/codegen.mjs`, `crates/riki-ipc/src/generated/` is generated from it, and the Tier 3 corpus is `fixtures/protocol/` with a half in each language ([ADR-0029](docs/adr/0029-newline-delimited-json-over-stdio-with-a-hello-ready-handshake.md)). The **voice window's** main ↔ renderer bridge is now here too (`schemas/voice.ts`, `voice-codec.ts`, `fixtures/protocol/voice/`) — a process boundary but not a language one, so nothing generates from it. The **overlay's** main ↔ renderer messages are still in `apps/desktop/src/shared` and have not moved |
| 3 | `packages/config` + `.env.example` + `.env` gitignored + API-key resolution (§7.1) | Every package that needs a setting, and all voice work. **Landed.** `env.ts` is the whole environment surface and everything else in the package is pure, so which layer wins is a Tier 1 test. `RIKI_OPENAI_API_KEY` deliberately has no CLI flag and no `settings.json` row — see §7.1 |
| 4 | `packages/gsi` + `packages/world-model` + `fixtures/gsi/` + `FakeGsiSource` + `tools/gsi-replay` | The dota2 §11.1 milestone, and `pnpm dev:replay`. **Landed except `tools/gsi-replay`** — `packages/gsi`, `packages/log-tail` and `packages/world-model` carry behaviour and tests, `FakeGsiSource` and the fixture corpus exist, but the replay tool and `pnpm dev:replay` still need the composition root (§8 of the state-capture architecture), which belongs to step 6 |
| 5 | `packages/context` + `fixtures/golden/` | Snapshot and coaching-brief format iteration. **Landed**, including `src/coaching/` and `fixtures/golden/coaching/`. The command surface this step originally included was deleted by ADR-0023 |
| 5b | `packages/events` + `apps/desktop/src/main/agent/` | Whether Riki speaks at all, and the wiring of events → context → realtime. **Landed** against `coaching-trigger-architecture.md`, which had to be written first — it was cited by four documents and had never been committed. Tuning (its §16 step 3) is open |
| 6 | `apps/desktop` shell: main process, tray, hidden overlay window, hotkey, Playwright harness | All UI work. **Landed except the Playwright harness.** `src/main/index.ts` has `app.whenReady()`, the single-instance lock and the quit drain; `main/shell/` is the Electron-free composition root, `main/state/` is state-capture §8, and `main/sidecar/`, `main/tray/` and `main/trigger/` are the three surfaces. The coaching root now runs in a real Electron process — verified by launching it, POSTing `fixtures/gsi/laning-phase.jsonl` at the live listener on 53101, and watching a coaching turn come out. Two gaps remain, each recorded at its seam (**speech** was the third and landed with step 7): **no push-to-talk** (`globalShortcut` is key-down only, so tap-to-latch works and hold does not — `trigger/index.ts`); **no capture** (the protocol now lands and the handshake is wired through `sidecar/protocol-codec.ts`, but no platform backend can capture yet, so `vision.enabled` stays false — ADR-0030) |
| 7 | `packages/realtime` + `FakeRealtimeTransport`, authenticating with the injected key from step 3 | Voice. **Landed.** The package itself was already implemented; what landed is the composition root either side of the preload bridge — `apps/desktop/src/renderer/voice/` hosts the microphone, the Web Audio graph and the peer connection (ADR-0010), `apps/desktop/src/main/voice/` mints the client secret and is the `CoachingSessionPort` (ADR-0015), and `main/index.ts` chooses it over `silent-session.ts` on whether a key was found. Verified by launching the app, replaying `fixtures/gsi/laning-phase.jsonl` and watching a match start reach a live `POST /v1/realtime/client_secrets`. **Not verified: a successful mint and the SDP exchange** — those need a real paid key, and §5.2 forbids a test that costs money |
| 8 | `crates/` sidecar skeleton + protocol handshake + `FakeVisionSidecar` | The CV spike in dota2 §11.3. **Landed except `FakeVisionSidecar` and any live capture backend.** `riki-vision` speaks the protocol, handshakes, runs crop → hash → change-gate over recorded frames and emits `cv.detections` with confidence, provenance and a timestamp; `apps/desktop` decodes it. Every platform backend reports itself unavailable — see [ADR-0030](docs/adr/0030-the-capture-seam-returns-cropped-regions-never-frames.md) for why, and `crates/riki-capture/src/platform.rs` for what each one needs |
| 9 | `bench/` + `docs/adr/` seeded + runbooks | Release gating |

Steps 1–3 are strictly sequential. 4–8 can run in parallel across agents, which is the point of
the layout.

Each step also updates its area's skill (§13.9). The nine skills exist already, seeded from the
design docs; scaffolding an area is the first chance to replace inherited assumptions with what
building it actually turned out to require.

---

## 11. Open decisions

Flagged rather than assumed. Each needs a human call or a spike.

1. **Electron vs. Tauri (⚑ A2, §1).** Proposed Electron for bundled-Chromium AEC. The cost is
   memory. If the frame-time harness says Electron is too heavy on a median Dota machine, this
   inverts — and it inverts cheaply only if it happens before `apps/desktop` has real depth.
   **Decide before step 6.**
2. **How does a non-developer user get a key?** Settled for alpha and beta: the developer's own
   `RIKI_OPENAI_API_KEY` in `.env` (A4, §7.1). Unsettled beyond that, and it is a product decision
   with a real architectural footprint. Three options, none free:
   - **User-supplied key in settings** — the env-var scheme with a UI on top. No backend, no
     hosting, no account system; a bad onboarding flow and a user who has to hold an OpenAI
     account and their own bill.
   - **A token-minting service** — ephemeral client secrets, the shape
     `openai-realtime-research.md` §9 argues for. Correct for a distributed binary, but it means
     hosting, accounts, rate limiting (§12 of that doc: the mint endpoint becomes the abuse vector),
     and billing for a product that otherwise has no server at all.
   - **Bring-your-own-key with a hosted option later** — ship the first, add the second if the
     audience widens.

   **Decide before the first build goes to anyone outside the team.** Until then the cost of being
   wrong is one file (`packages/config`), which is exactly why the key is confined there.
3. **git-lfs for `fixtures/frames/`.** Correct technically; adds a setup step and a bandwidth
   cost. The alternative is a scripted download from object storage.
4. **Rust vs. C++ for the sidecar.** Proposed Rust. Worth confirming against whatever
   ScreenCaptureKit binding maturity actually looks like when someone builds the dota2 §11.3
   spike — that is the binding that decides it, since macOS is the primary target and
   ScreenCaptureKit is an Objective-C API reached through `objc2`-style bindings rather than a
   C ABI.
5. **Where does the agent's prompt/persona live?** It is neither code nor doc exactly. Proposal:
   versioned prompt files in `packages/context/prompts/` with golden tests, so a persona change
   shows up as a reviewable diff. **More urgent since ADR-0023**: with no tool descriptions, the
   preamble persona is the only thing shaping how Riki sounds, and one of its rules is not
   stylistic — *say when you do not know* — because the agent can no longer look anything up
   (coaching §3.2, §7.4).
6. **Anti-cheat spike must precede step 6.** `ui-design.md` §13.3 calls this a blocking risk. If a
   global hook plus an always-on-top window is not viable, the entire trigger design changes and
   the overlay directory is wasted work.

---

## 12. Rejected alternatives

Recorded so they are not re-proposed.

| Rejected | Why |
|---|---|
| Single flat `src/` | Three subsystems in two languages with parallel agents; flat layout guarantees merge conflicts and hides the seams the design docs are explicit about |
| Separate repos per component | The protocol contract has to be versioned in lockstep; polyrepo makes the most fragile boundary the hardest to change |
| Python for the CV layer | Cannot meet the ≤3% core budget in `dota2-state-capture-design.md` §1; fine for a labelling tool, not for the shipping path |
| CV in-process with the app | §3 requires the CV worker to crash without taking the agent down |
| Jest | Vitest is faster, ESM-native, and shares config with Vite in the renderer |
| Biome instead of ESLint + Prettier | The boundary rules in §6.2 are the point, and they need ESLint's plugin ecosystem |
| A blanket coverage threshold | Pushes effort toward wiring code and away from `world-model` / `context` / `events`, where bugs become wrong advice in a player's ear |
| Tests that drive a real Dota 2 client | Non-deterministic, impossible in CI, and impossible for the agents doing the work (A6) |
| Mock-heavy unit tests over shared fakes | Divergent mocks per package drift from reality; shared fakes stay honest because `pnpm dev:replay` uses them too |
| A token-minting service for alpha/beta | Hosting, accounts, and rate limiting to solve a distribution problem that does not exist while the only users are the people building Riki. `RIKI_OPENAI_API_KEY` in a local `.env` costs one line (§7.1). Revisit at distribution, not before (§11.2) |
| The API key in the committed user config file or in `packages/realtime` directly | `.env` is gitignored and `packages/config` is the one module that reads the environment (§6.2). Both alternatives put a live key somewhere a lint rule cannot see it |

---

## 13. Skills

> Numbered last because inserting a section in the middle would renumber every cross-reference
> in this document, and roughly a third of the `§N` references here point at *other* documents.
> Read it after §3; it is the fourth kind of writing this repo keeps, and the only one that
> reaches an agent without the agent going looking.

`docs/` records what we decided and why. It does not follow anyone into a task. A skill does:
Claude Code loads a project skill automatically when the work matches its description, so the
knowledge arrives unprompted.

That difference is the entire justification for having both. Per A5, the agent who works on
`packages/events` next week has no memory of this repository and did not read this file. The
realistic failure is not that a design doc was wrong — it is that nobody opened it. Skills are
how the repo pushes rather than waits.

### 13.1 Where they live, and why they are committed

```
.claude/
├── settings.json                    marketplaces + enabled plugins (already committed)
└── skills/
    ├── workspace/SKILL.md
    ├── protocol/SKILL.md
    ├── testing/SKILL.md
    ├── game-state/SKILL.md
    ├── agent-context/SKILL.md
    ├── voice-realtime/SKILL.md
    ├── overlay-ui/SKILL.md
    ├── vision-sidecar/SKILL.md
    └── config-secrets/SKILL.md
```

Project scope, in git — the same mechanism and the same reasoning as
`docs/superpowers-plugin-decision.md`: committed means every collaborator and every dispatched
agent gets the identical set with no per-machine setup. `.claude/settings.local.json` remains
gitignored and personal, and is where someone opts out of anything.

These are Riki's own skills. They sit alongside the 14 `superpowers:*` skills the plugin
already provides, which cover *method* — brainstorming, TDD, systematic debugging, verification
before completion. **Riki's skills cover this codebase and nothing else.** A skill here that
explains how to write a good test is duplicated effort that will rot; a skill that says *no test
in this repo may require a running Dota 2 client* is not written down anywhere an agent will
trip over it otherwise.

### 13.2 Skill versus document

The repo now keeps four kinds of writing, and the boundary is worth stating once.

| Kind | Answers | Read when | Source of truth for |
|---|---|---|---|
| Design doc (`docs/`) | How the system should work | You start in an area | Behaviour, architecture |
| Research note (`docs/`) | What is true about the outside world | You evaluate an external dependency | External facts |
| ADR (`docs/adr/`) | What we decided, and whether it still stands | Before re-litigating | Decisions |
| **Skill** (`.claude/skills/`) | **How to do the work here without repeating a known mistake** | **Automatically, whenever a task touches the area** | **Nothing** |

Two rules keep that from blurring:

1. **Skills are procedural; docs are declarative.** A skill says "GSI's rate is unreliable —
   derive timing from `map.clock_time`, never from update count." The doc says why, with the
   measurements. The skill cites the doc rather than restating its numbers, because a number
   copied into two files diverges.
2. **On conflict, the document wins.** A skill that disagrees with its design doc is stale, not
   authoritative. Fix it in the same commit as whatever you were doing when you noticed.

### 13.3 The roster — one skill per area

Deliberately mirrors the ownership map in §2.2, so that *where does my task go* and *which skill
fires* have the same answer.

| Skill | Fires when the task is about | Area | Primary spec |
|---|---|---|---|
| `workspace` | Starting or finishing anything; which package owns a change; recording a learning | repo-wide | §2, §8, §9, §13.5 |
| `protocol` | Any message crossing a process or language boundary; `pnpm codegen` | `packages/protocol`, `crates/riki-ipc` | §4 |
| `testing` | Writing a test, adding a fixture, deciding if something is testable | everywhere | §5 |
| `game-state` | GSI POSTs, console log, fusion, staleness, confidence | `packages/gsi`, `log-tail`, `world-model` | dota2 §2, §4 |
| `agent-context` | The snapshot the LLM sees, the coaching brief, whether Riki speaks | `packages/context`, `packages/events` | dota2 §6, coaching |
| `voice-realtime` | Realtime session, transport, barge-in, mic and speaker path | `packages/realtime`, `packages/audio` | realtime §3–§5 |
| `overlay-ui` | The chip, tray, global hotkey, settings, any visible surface | `apps/desktop` | ui-design §3–§10 |
| `vision-sidecar` | Screen capture, CV, the perf budget, the sidecar process | `crates/riki-*` | dota2 §2.2 |
| `config-secrets` | A new setting, an env var, the API key, anything that logs | `packages/config`, `packages/telemetry` | §7 |

**Nine, not twenty-five.** A skill scoped to too narrow a slice never fires, and one scoped to
everything fires constantly and gets ignored. The split point is the directory an agent will be
working in for the whole task. `game-state` bundles three packages because a task touching GSI
almost always touches fusion; it splits into `gsi` and `world-model` the day it outgrows the
size cap (§13.6), and that split is a normal event, not a failure.

**What this costs.** Only each skill's `description` line is always-on: ~3.2 kB across all nine,
call it **~800 tokens per session** — slightly more than the ~688 the Superpowers plugin already
adds, and measured rather than guessed. Bodies are 2.3–3.8 kB — roughly 600–1,000 tokens — and
load only on a match.

That is a real budget, and it is spent deliberately: descriptions are written to *match* — naming
the directories, file types and the words a task will actually use — rather than to *summarise*.
A description that reads well but does not fire has cost tokens and delivered nothing. If the
roster grows past roughly a dozen skills, tighten descriptions before adding more.

### 13.4 Format

```markdown
---
name: <matches the directory name>
description: <what it covers and when to use it — this is the matching surface>
---

# <Title>

<the rules that hold in this area, each traceable to a spec>

## Learnings
<dated entries, newest first>

## See also
<the docs that are the source of truth>
```

Constraints, all checkable (§13.7):

- `name` matches the directory; `description` is present and written for matching.
- **≤150 lines.** Past that it is a document, not a skill.
- Every rule is traceable to a spec section or to a dated learning. A rule with no provenance
  is folklore, and folklore is what skills are supposed to replace.
- Learnings carry a date, because a stale learning is only detectable if you can see its age.

Superpowers ships a `skill-authoring` skill; use it when creating a new one.

### 13.5 Keeping them current — the update protocol

This is the part that has to be automatic, because it is the part that will otherwise never
happen.

**The trigger is finishing a task.** Before you commit, ask: *did I learn something that would
have saved me time at the start?* If yes, it goes into the area's skill **in the same commit as
the work**. Not a follow-up task and not a note to the orchestrator — per `AGENTS.md` there is
no review queue, and the next agent in this area will be someone else with no memory of your
session. A learning that is not committed did not happen.

**What qualifies:**

- A mistake you made that the docs did not warn you about.
- A command, flag or incantation that worked after several that did not.
- A limit or quirk you *measured* rather than read.
- An approach you tried and abandoned, with why — this is the highest-value kind and the one
  most often lost.

**What does not:**

- Restating a design doc. Link it instead.
- General TypeScript or Rust advice. `superpowers:*` covers method.
- Anything true only of the data in your one task.

**Where else it might belong.** The skill is the default, not the only destination:

| What you learned | Where it goes |
|---|---|
| It contradicts a design doc | Fix the doc. Touch the skill only if the *procedure* changes |
| It is a decision | An ADR in `docs/adr/`, and the skill links to it |
| It is a fact about an external system | A research note in `docs/` |
| It is "how not to get this wrong here" | The skill — **this is the default** |

**How to write it.** Add an entry under `## Learnings` with the date and one line of *why*:

```markdown
## Learnings

**2026-08-14 — `cargo watch` fights the sidecar supervisor.** Rebuilds trigger a restart
storm because the supervisor's backoff resets on a clean exit. Use `pnpm dev` rather than
running `cargo watch` directly, or set `RIKI_FAKE_VISION=1`.
```

If the learning changes how the area should be worked — not just a one-off gotcha — promote it
into the body as a rule and leave the dated entry as its provenance.

### 13.6 Pruning — append-mostly, not append-only

A skill that only grows becomes a changelog, and nobody reads a changelog before starting work.

- **When a learning becomes enforcement, delete it.** A lint rule, a type or a test that makes
  the mistake impossible is strictly better than a paragraph asking people to remember. Say so
  in the commit: the knowledge moved, it was not lost.
- **When a learning is superseded, replace it** rather than appending a contradiction. Two
  entries that disagree leave the reader to guess which is current.
- **At the 150-line cap, split or promote.** Split along the directory boundary if one exists;
  promote to a design doc if what has accumulated is really architecture.

### 13.7 Validation

⚠ **Not built yet** — no `check:skills` script exists, and neither `pnpm check` nor `docs.yml`
calls one. This section is the specification for it, not a description of something running.
When it lands, wire it into both and drop this notice.

`pnpm check:skills` should validate:

- Frontmatter parses; `name` matches the directory; `description` is non-empty and under the
  length limit.
- Body is under the line cap.
- Every internal link resolves — this is what catches skills left pointing at a doc that moved,
  including the `docs/` reorganisation proposed in §3.
- Every area in the §2.2 ownership map maps to exactly one skill. A new package with no owning
  skill fails the check, which is how the roster stays complete as the codebase grows rather
  than by anyone remembering.

`docs.yml` is written to run markdownlint and the lychee link check over `docs/` (it is parked
with the rest of CI, §8.2); extend both to `.claude/skills/**`.

### 13.8 Parallel agents

Skills are per-area precisely so that two agents working at once do not touch the same file —
the same reasoning as the directory layout (§2.1). `workspace` is the shared one: append at the
end, do not restructure it, and if you find yourself rewriting its shape, that is a task in its
own right rather than a side effect of another one.

### 13.9 Lifecycle

A skill is created **with** its area, not after it. In the scaffolding order (§10), whoever
lands step *N* lands that area's skill in the same commit, seeded from the design doc's
constraints. The nine skills above are seeded now, ahead of the code, because the design corpus
already contains most of what they need to say and because the agents doing the scaffolding are
the first people who need them.

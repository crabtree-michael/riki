# Riki

Riki is invisible until needed.

A voice agent that watches a live Dota 2 match and talks to you about it — a click-through
overlay chip, a push-to-talk hotkey, and no in-game footprint at all. It observes only what the
player can already see, through channels Valve provides: Game State Integration, the client's
console log, and screen capture.

**Status: skeleton.** The layout, gates, and configuration exist; the features do not. See
[REPO_SKELETON.md §10](REPO_SKELETON.md) for what lands next.

## Quick start

```shell
pnpm setup     # deps, fixtures, hooks, and a .env from the template
pnpm check     # lint + format + typecheck + test + codegen — the whole gate
```

No Dota 2, microphone, GPU, or OpenAI API key required. That is enforced, not aspirational: no
test may depend on any of them.

## Platforms

**macOS is the primary target.** Dota 2 ships a native macOS client, so Game State Integration
runs on Valve's supported path there, and capture uses ScreenCaptureKit.

**Linux is the development platform, not a shipping target.** Everything above the capture
backend is built and tested there; the pieces that cannot be — ScreenCaptureKit, the global key
tap, `setContentProtection` — are the pieces that need a Mac and a
[spike](docs/runbooks/anticheat-validation.md) before anything is built on them. **Windows is a
later target.** Its capture backend (WGC) is designed for but not started.

Two macOS permissions gate the product and both fail silently when denied — Screen Recording
returns black frames, Accessibility delivers no key events. Detecting and reporting them is a
requirement, not polish. See [ui-design.md](docs/design/ui-design.md) §6.4–6.5.

## Layout

| Directory       | What lives there                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/` | The Electron app: lifecycle, tray, hotkeys, overlay window, sidecar supervisor. Deliberately thin.                   |
| `packages/`     | The testable core — GSI, world model, context, events, realtime, audio, config, telemetry, and the protocol contract |
| `crates/`       | The Rust capture/CV sidecar, a separate process with a hard perf budget                                              |
| `fixtures/`     | Recorded sessions, frames, and transcripts. What makes the repo workable without a game running                      |
| `tools/`        | Dev-only executables — recorders, replayers, labellers. Nothing here ships                                           |
| `bench/`        | CV micro-benchmarks (CI-gated) and the frame-time harness (manual, release gate)                                     |
| `docs/`         | Design, research, decisions, runbooks — [start here](docs/README.md)                                                 |

Full layout, testing strategy, lint gates, and the reasoning behind all of it:
[REPO_SKELETON.md](REPO_SKELETON.md).

## Commands

| Command           | Does                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `pnpm setup`      | One command for a fresh clone                                           |
| `pnpm check`      | lint + format + typecheck + test + codegen-clean. Run before committing |
| `pnpm test`       | Vitest + `cargo test`. No game, no network, no GPU, no API key          |
| `pnpm dev:replay` | The whole app driven from fixtures. No Dota and no API key required     |
| `pnpm dev`        | Electron + Vite HMR + `cargo watch`                                     |

The canonical list is [REPO_SKELETON.md §8.1](REPO_SKELETON.md). Commands whose subsystem is not
built yet print what they are blocked on instead of failing obscurely.

## Contributing

Humans: [CONTRIBUTING.md](CONTRIBUTING.md). Agents: [AGENTS.md](AGENTS.md).

## Development environment

This repo ships a shared Claude Code configuration in `.claude/settings.json`. It registers
Anthropic's official plugin marketplace and enables the
[Superpowers](https://github.com/obra/superpowers) plugin at project scope, so every
collaborator gets the same agent workflows by default. The reasoning is in
[ADR-0007](docs/adr/0007-superpowers-plugin-enabled-by-default.md); setup and opt-out are in
[docs/runbooks/claude-plugin-setup.md](docs/runbooks/claude-plugin-setup.md).

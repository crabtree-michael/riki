# ADR-0001: Electron and TypeScript for the application shell

**Status:** Accepted, with a named condition that can invert it
**Date:** 2026-08-01

## Context

Riki is a desktop app running alongside Dota 2: a click-through overlay with per-pixel alpha, a
tray icon, global hotkeys, and a live voice session. The shell technology determines the
directory layout, the testing story, and — via the mic stack — whether the voice loop works at
all.

## Decision

Electron with TypeScript for the shell, overlay, tray, hotkeys, and the world model. Rust for
the capture/CV sidecar ([ADR-0005](0005-monorepo-and-protocol-package.md) covers the split).

Electron bundles Chromium, which is the only route that gives us WebRTC _and_ known-good
acoustic echo cancellation. AEC is not a nice-to-have: the realtime research documents
self-interruption loops as a reliable failure without it.

## Consequences

- The renderer owns the microphone, which is what [ADR-0002](0002-webrtc-transport.md) assumes.
- The cost is memory: Electron's baseline RSS is ~150–250 MB before Riki does anything. There is
  no committed ceiling at this stage, so this is a concern to measure rather than a limit to
  enforce.
- **The condition:** if the frame-time harness says Electron is too heavy on a median Dota
  machine, this decision inverts. It inverts cheaply only while `apps/desktop` is still thin, so
  the measurement has to happen before the desktop shell gains depth.

## Alternatives rejected

- **Tauri** — per-OS webview means per-OS AEC variance, which is exactly the risk we cannot
  absorb. Would also need a native WebRTC stack.
- **Pure Python** — cannot meet the CV budget, no good overlay story.
- **A web app** — no overlay, no global hotkeys.

See [REPO_SKELETON.md](../../REPO_SKELETON.md) §1 and
[openai-realtime-research.md](../research/openai-realtime-research.md) §9, §11.5.

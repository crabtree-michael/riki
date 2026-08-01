# ADR-0010: A dedicated hidden window owns the microphone, not the overlay

**Status:** Accepted (2026-08-01 — `packages/realtime` built against it; see [ADR-0017](0017-voice-input-module-decomposition.md))
**Date:** 2026-08-01

## Context

[ADR-0002](0002-webrtc-transport.md) makes WebRTC the Realtime transport and
[ADR-0001](0001-electron-shell.md) chose Electron for Chromium's acoustic echo cancellation,
which the research note calls mandatory. Both imply a Chromium renderer owns `getUserMedia` and
the peer connection. The overlay is already a renderer, so it is the obvious host.

It is also the worst one. The overlay window is shown and hidden on every interaction, re-placed
on display and HUD-scale changes, and required to cost nothing at all when idle
(`ui-design.md` §10). A live audio session in that window would be coupled to all of it, and a
crash in the chip's drawing code would take the conversation down with it.

## Decision

A separate `BrowserWindow` — created when a match starts, never shown — owns the microphone, the
peer connection and the audio graph. The overlay window is view-only: it receives a view model
and level frames and holds no audio objects. Level frames reach the chip as voice window → main →
overlay window.

## Consequences

- The overlay renderer can stop every timer when hidden without touching the voice session, which
  is what makes "idle costs literally nothing" true rather than aspirational.
- A crash on either side is survivable alone: the chip reloads without dropping the session, and
  a voice-window crash surfaces as an Error chip rather than a black screen.
- Overlay end-to-end tests need no microphone permission and no audio device, which keeps them
  inside REPO_SKELETON §5.2's rule.
- It costs a renderer process — real memory, on a machine that is also running Dota, and
  Electron's footprint is already the open question in REPO_SKELETON §11.1.
- Level frames take one extra hop. At 30 Hz against a 250 ms budget this is not measurable, but
  it is one more thing between the mic and the bars.
- It constrains `packages/realtime`'s host, which is why this was Proposed rather than Accepted:
  the agent who builds that package owns the decision and may have a reason to fold the two
  windows together. **That agent has now built it and found no such reason** — the package reads no
  globals and takes its transport by injection, so the window split costs it nothing and the
  ephemeral-secret boundary in `auth/credentials.ts` depends on it. Accepted.

## Alternatives rejected

- **The overlay window hosts the session.** Couples a live conversation to a window whose whole
  job is to appear and disappear.
- **The audio graph in the main process via a Node backend.** Loses Chromium's AEC, which is the
  reason the shell is Electron at all; the research note documents self-interruption loops as a
  reliable failure without it.
- **A hidden `<audio>`/worklet in the settings window.** Ties the session's lifetime to a window
  the user can close.

See [overlay-architecture.md](../design/overlay-architecture.md) §3.2 and
[openai-realtime-research.md](../research/openai-realtime-research.md) §11.5.

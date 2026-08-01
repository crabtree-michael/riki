# ADR-0002: WebRTC as the Realtime API transport

**Status:** Accepted
**Date:** 2026-08-01

## Context

The OpenAI Realtime API offers WebRTC and WebSocket transports. Riki's audio path runs while a
game is running and while game audio is playing out of the same speakers the microphone can
hear.

## Decision

WebRTC is the transport. `RIKI_REALTIME_TRANSPORT` exists so a WebSocket path can be exercised,
but WebRTC is the default and the one the product is designed around.

## Consequences

- A Chromium-class renderer owns the microphone, which is what
  [ADR-0001](0001-electron-shell.md) delivers. The two decisions stand or fall together.
- Browser-grade echo cancellation, noise suppression, and jitter buffering come for free, and
  they are what stops Riki interrupting itself.
- Audio never crosses the preload bridge as raw PCM in the common path; `packages/audio` deals
  in levels and envelopes for the chip's bars.

## Alternatives rejected

- **WebSocket** — viable, but we would own jitter buffering and echo cancellation ourselves, and
  AEC is the part that has to be right.

See [openai-realtime-research.md](../research/openai-realtime-research.md) §2, §11.5.

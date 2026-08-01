# ADR-0004: Push-to-talk by default

**Status:** Accepted
**Date:** 2026-08-01

## Context

Riki has to decide when the microphone is open. The alternatives run from always-listening with
voice activity detection, through a wake word, to a held hotkey.

## Decision

Push-to-talk is the default trigger. Other modes may be offered, but this is what a fresh
install does.

## Consequences

- Matches existing game-voice muscle memory — players already hold a key to talk.
- The mic is closed except while the key is held, which makes the privacy story explainable in
  one sentence rather than a paragraph of qualifications.
- Zero false triggers from teammates on voice comms or from game audio.
- It makes the global hotkey layer load-bearing, and Linux/Wayland has no global hotkey API by
  design. The anti-cheat and hotkey-capture spike must land before UI is built on top of it.
- The ≤100 ms key-down → chip-visible budget becomes a product requirement, tested end to end.

## Alternatives rejected

- **Always-on VAD** — false triggers from teammates and game audio; a much harder privacy story.
- **Wake word** — shipped as an option, off by default; adds an always-open mic without the
  clarity of a held key.

See [ui-design.md](../design/ui-design.md) §6.1 and §6.4.

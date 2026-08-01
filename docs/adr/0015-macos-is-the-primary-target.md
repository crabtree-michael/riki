# ADR-0015: macOS is the primary target platform

**Status:** Accepted
**Date:** 2026-08-01

## Context

[`ui-design.md`](../design/ui-design.md) §0 assumption **A3** has said, since the first design
document landed, that "Windows is the primary target for players; Linux is the dev platform and a
secondary target." macOS appears nowhere in the corpus as a player target — it is named only in
`dota2-state-capture-design.md` §2.2 as one of three capture backends.

That assumption is now reversed by a product decision. It is being recorded as an ADR rather than
as an edit to A3 alone because A3 is marked ⚑ — load-bearing — and several other documents were
written downstream of it without saying so.

## Decision

**macOS is the primary target platform.** Windows and Linux remain supported targets and nothing
is removed for them, but where a design must choose — a default, an ordering, which backend gets
built first, which platform's limitations shape a feature — macOS wins. `ui-design.md` A3 is
amended to say so and to point here.

## Consequences

- **Ducking is gone as a feature on the primary platform.** macOS has no public API for
  attenuating another application's audio, so ui-design.md §7.2's −12 dB is unimplementable for
  most users. This is significant enough to be its own decision: [ADR-0016](0016-ducking-is-a-no-op-by-default.md),
  with the evidence in [audio-ducking-platform-support.md](../research/audio-ducking-platform-support.md).
- **The capture backend order inverts.** `dota2-state-capture-design.md` §2.2 lists WGC first;
  ScreenCaptureKit is now the one that has to work first, and REPO_SKELETON §11.4's "how mature
  are the WGC / ScreenCaptureKit bindings really" spike should be run against ScreenCaptureKit.
- **The hotkey and overlay risk profile changes and has not been re-assessed.** `ui-design.md`
  §6.4 and §6.5 are written around `WH_KEYBOARD_LL` and `WS_EX_LAYERED`; the macOS equivalents
  (a `CGEventTap`, which requires Accessibility permission the user must grant, and a
  non-activating panel) have different failure modes. §13.3's anti-cheat spike — already flagged
  **blocking** — now needs to be run on macOS, and the Accessibility-permission flow is new
  onboarding work that nothing has budgeted for.
- **`setContentProtection` behaves differently.** overlay-architecture.md §3.1 already notes it
  maps to a sharing exclusion on macOS rather than window affinity; that is now the primary path
  rather than the footnote.
- **Dota 2's own macOS support is the risk this decision carries.** It is materially less
  exercised than the Windows build, and `dota2-state-capture-design.md` §2.1 already flags GSI as
  historically buggy off Windows. Validating GSI delivery on macOS moves up the list.
- Nothing about the TypeScript packages changes. `@riki/audio` and `@riki/realtime` read no
  globals and take platform as a parameter, so the platform decision reaches them as data.

## Alternatives rejected

- **Leave A3 as-is and treat macOS as an equal third target.** "All three equally" is how you get
  a feature designed on Windows semantics that no one notices is impossible elsewhere until
  implementation — which is precisely what happened with ducking.
- **Amend `ui-design.md` A3 in place with no ADR.** A3 is marked ⚑ and other documents were
  written downstream of it. A silent edit leaves no record that the reversal was deliberate.

# ADR-0009: The interaction state machine lives in the main process

**Status:** Accepted
**Date:** 2026-08-01

## Context

The overlay chip, the tray glyph and the earcons all answer the same question — what is Riki
doing right now — and `ui-design.md` gives each of them its own table (§3, §2.3, §7.1). The
natural place to put the state that drives the chip is the renderer that draws it.

Three constraints pull the other way. The ≤100 ms key-down → chip-visible budget (ui-design §8)
is spent in the process that receives the hotkey and owns the window, which is main. The tray and
the earcons are projections of the same state, and they live in main regardless. And a renderer
crash mid-turn must not lose the interaction or leave the microphone open.

## Decision

The interaction state machine is a pure reducer in `apps/desktop/src/main/session/`. The overlay
renderer is a projection of it: it receives a `ChipViewModel` and a level stream over the preload
bridge and holds only presentation state — animation phase, level ballistics, fade opacity. The
tray glyph is a second projection of the same state; earcons and ducking are its effects.

## Consequences

- The show call happens in the same tick as the key press. `SessionRuntime.dispatch` is
  synchronous and the `window` effect is applied first, so nothing is between the hotkey and
  `showInactive()`.
- The chip, the tray and the earcons cannot disagree, because there is one state to disagree
  with.
- The reducer is pure and clock-injected, so the whole state × input table — barge-in, Esc from
  every phase, the tap/hold gesture, the six timers — is a Tier 1 unit test with no window, no
  Electron and no game.
- A renderer crash costs a reload: the machine is untouched, the renderer sends `ready`, main
  re-projects.
- It costs a view model and a wire format. Every new piece of chip state has to be added to the
  projection as well as the machine, and the two can drift.
- It puts a process boundary between the state and the pixels. Debugging "the chip shows the
  wrong thing" now means reading two logs. Model revisions are monotonic so a stale model is
  detectable rather than merely suspected.
- The renderer becomes replaceable — a different view technology, or a second surface, is a new
  projection rather than a rewrite.

## Alternatives rejected

- **Machine in the renderer, main as a dumb event forwarder.** Puts an IPC round trip inside the
  100 ms budget and gives the tray a second copy of the state to get wrong.
- **Two machines, one per surface, synchronised.** The synchronisation is the bug. This is the
  arrangement that produces a tray saying idle while the chip says listening.
- **A state library (XState or similar) in either process.** The state model is nine phases and
  six timers; a hand-written discriminated union plus `reduce` is smaller than the adapter would
  be, and keeps `apps/desktop` free of a dependency that would end up in the renderer bundle.

See [overlay-architecture.md](../design/overlay-architecture.md) §2.2 and §4.

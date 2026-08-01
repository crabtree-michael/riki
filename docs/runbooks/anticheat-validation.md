# Runbook: anti-cheat validation

**Status: NOT RUN.** This is a blocking risk, not a formality.

Some things cannot be unit tested, and this is the clearest example. Riki's trigger design rests
on a global hotkey hook plus an always-on-top window sitting over a running game. If anti-cheat
treats either as hostile, the overlay and hotkey work is wasted and the trigger design changes.

Run this before any UI is built on the hotkey layer.

## What to establish

Run it on **macOS first** — that is the primary target (`ui-design.md` A3), and it is also where
the permission model adds failure modes the other platforms do not have. Dota 2 is protected by
VAC, not by a kernel-level anti-cheat, which is the favourable case; establish it rather than
assume it.

1. **Global key tap.** Does a `CGEventTap` on `keyDown`/`keyUp` registered by a separate process
   deliver events alongside a running Dota 2? Test both with Dota focused and with the overlay
   focused. Confirm what happens when Accessibility is granted, denied, and revoked mid-session.
2. **Always-on-top window.** Does a click-through window with per-pixel alpha render over the
   game in windowed, borderless, and native fullscreen? Native fullscreen is the macOS-specific
   one — the game gets its own Space, and this is the case §6.5 of `ui-design.md` works around.
3. **Screen capture.** Does ScreenCaptureKit window-scoped capture of the game work under each
   display mode, and does it trigger anything? Record what a denied Screen Recording grant looks
   like from inside the sidecar — black frames, an error, or nothing.
4. **Silent failure.** The worst outcome is not a block but a hotkey or a capture stream that
   stops delivering without an error. Both macOS permissions are revocable at any time and are
   invalidated when the bundle signature changes, so this is the likely failure, not the exotic
   one. Confirm delivery is detectable at bind time.

## How to record the result

Write the outcome back into this file — date, Dota build, OS build, anti-cheat versions, and
what happened in each case. A result nobody can find is the same as not having run it.

If any of the four fails, say so loudly: it changes
[ADR-0004](../adr/0004-push-to-talk-default.md) and the overlay design, and Kiln needs to know
before more work lands on top.

## Result

_Not yet run._

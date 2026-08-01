# Runbook: anti-cheat validation

**Status: NOT RUN.** This is a blocking risk, not a formality.

Some things cannot be unit tested, and this is the clearest example. Riki's trigger design rests
on a global hotkey hook plus an always-on-top window sitting over a running game. If anti-cheat
treats either as hostile, the overlay and hotkey work is wasted and the trigger design changes.

Run this before any UI is built on the hotkey layer.

## What to establish

1. **Global hotkey hook.** Does a low-level keyboard hook registered by a separate process
   survive alongside Dota 2 with EAC / BattlEye / Vanguard-class anti-cheat present? Test both
   with Dota focused and with the overlay focused.
2. **Always-on-top layered window.** Does a click-through window with per-pixel alpha render
   over the game in windowed, borderless, and exclusive fullscreen? Exclusive fullscreen is the
   one that historically fails.
3. **Screen capture.** Does frame capture of the game window work under each display mode, and
   does it trigger anything?
4. **Silent failure.** The worst outcome is not a block but a hotkey that stops delivering
   without an error. Confirm delivery is detectable at bind time.

## How to record the result

Write the outcome back into this file — date, Dota build, OS build, anti-cheat versions, and
what happened in each case. A result nobody can find is the same as not having run it.

If any of the four fails, say so loudly: it changes
[ADR-0004](../adr/0004-push-to-talk-default.md) and the overlay design, and Kiln needs to know
before more work lands on top.

## Result

_Not yet run._

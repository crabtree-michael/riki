# ADR-0028: Mute has one producer, and it is the menu row

**Status:** Accepted
**Date:** 2026-08-02

**Amends:** [`ui-design.md`](../design/ui-design.md) §2.3, which specified "Left-click → toggle
mute. Right-click → menu".

## Context

`createTrayController` subscribed two producers to one `muteListeners` set: the `toggle-mute` menu
row, and `TraySurface.onClick`. §2.3 asked for both, and the code was a faithful reading of it.

The two are not independent gestures. A tray icon that has a context menu opens that menu when it is
clicked — on macOS, the primary target, with **either** button, and macOS emits `click` alongside.
`createElectronTray` calls `tray.setContextMenu(...)` on every `render`, so there has never been a
left-click that did not also open the menu.

So the specified gesture could not be performed. Every attempt to read the status line — the one
thing §2.2 says the tray exists for, *"is Riki even on?"* — toggled mute as a side effect. The menu
that then appeared was built from the pre-toggle model, so its `Mute Riki` checkbox showed the
opposite of what had just happened, and the fix for a Riki that had gone quiet was to click the icon
again, which unmuted it and looked like the checkbox was simply lagging.

The failure is invisible to the type system and was invisible to the tests: `tray.test.ts` asserted
`treats a left-click and the mute row as the same request`, which is the bug stated as an
expectation. It passed.

## Decision

**The `toggle-mute` menu row is the only producer of a mute toggle.** The click channel is removed
outright — `TraySurface.onClick`, the `tray.on('click')` subscription in `createElectronTray`, and
the controller wiring between them. `TrayController.onToggleMute` stays, with one producer.

`onAction` continues to filter `toggle-mute` out of the generic action channel even though that
channel now has a single member, `quit`. Mute is the one action with a state consequence the shell
must mirror back (`setMuted`, so the checkbox matches), and folding it into generic dispatch is
precisely how it would acquire a second producer again.

§2.3's menu drawing is unchanged. Only the gesture line above it is amended.

## Consequences

Left-clicking the icon opens the menu and does nothing else, on every platform. Muting takes two
clicks instead of one, or the `⌥⌘M` accelerator that the menu row already carries and that always
worked — it goes through the menu item, never through `click`.

Windows and Linux lose a left-click action they nominally had. They lose nothing real: the same
`setContextMenu` call means the click opened the menu there too.

If a left-click gesture is ever wanted again, it must not be mute. `popUpContextMenu` for a
platform where the menu does not open on its own is the plausible use, and it belongs on the
surface, not on a listener set shared with a menu action.

## Alternatives considered

**Keep `onClick` and drop the menu row.** Inverts the bug: mute becomes the gesture with no visible
affordance and no checkbox, on the surface §2.2 designates as the answer to "is Riki on?".

**Debounce, or suppress the click while the menu is open.** Timing arbitration between two things
that are one event. It would still mute on some clicks, which is worse than muting on all of them —
a bug that reproduces reliably is one someone can report.

**Keep `TraySurface.onClick` unwired, for later.** A port method with no subscriber is an invitation
to wire it to whatever is nearby, which is how this happened. It is three lines to add back with a
purpose.

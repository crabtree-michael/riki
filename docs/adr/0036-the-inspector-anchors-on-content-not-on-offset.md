# ADR-0036: The inspector anchors on content, not on an offset

**Status:** Accepted
**Date:** 2026-08-02

## Context

The inspector redraws its whole document on every frame — 4 Hz, a few hundred nodes — and
ADR-0032's long form calls that out as deliberate: no diffing and no keyed reconciliation removes
the class of bug where a stale node survives because its key did not change, which in a window whose
only job is to be believed is disqualifying. debug-inspector.md §9 recorded the cost as known:
"text selection and scroll position inside a panel are lost on every redraw, which is what the
freeze button is for."

That was the wrong verdict on half of it. Losing scroll position at 4 Hz does not degrade the
window, it removes the feature: scrolling up to read the tick before this one lasts 250 ms, and then
the reader is back at the top. Telling them to freeze first means the tool only works on a session
they have already stopped following, which is the opposite of what a live inspector is for.

The obvious repair — save `scrollTop` before the redraw, put it back after — fixes the wrong
problem. The panels that grow (Triggers, Coach turns, Problems) render **newest-first**, so an
arriving tick is *prepended*: every pixel offset below it is wrong by the height of what landed, and
restoring the saved number lets the row being read crawl down the screen four times a second. It is
the same complaint in slower motion.

## Decision

**Three nodes and two buttons are exempt from the redraw, and position is restored by content
rather than by offset.**

The three `.ins-column` scroll containers persist for the life of the window and each redraw
replaces only their children. `scrollTop` is a property of the element: a column rebuilt from
scratch arrives at the top with no position to preserve, so no restore afterwards can invent one.
The header's two buttons persist for the neighbouring reason — they are the only focusable things on
the screen, and a `<button>` destroyed mid-frame takes keyboard focus to `<body>` with it. Everything
*inside* a column is still rebuilt whole.

`view.ts` stamps a `data-ins-key` on anything repeated — `tick:41`, `turn:coach_7`,
`fact:self.gold`, `row:intensity` — derived from the frame and never from render order, and
`panel()` namespaces every key beneath it by the panel's title in one pass. `scroll.ts` records the
topmost keyed element on screen and its height above the fold, and after the swap finds that key
again and moves the container by the difference.

The two edges are pinned instead of anchored, because there the reader's intent is clearer than any
anchor. At the top means *follow the newest*, which — newest-first — is where new rows appear. At
the bottom means *keep the oldest row still* while the buffer grows above it, which is the
chat-log behaviour and, in a prepending list, the correct content anchor for the end of the buffer.
Four pixels of slack on each, because a trackpad rarely lands on zero.

## Consequences

**What it buys.** The window is readable during the only period it is worth reading. A reader parked
on tick #41 stays on tick #41 at the same height while #42 through #48 arrive above it, and keeps
their place until the hub's ring buffer drops #41 — at which point the saved offset is the fallback,
wrong by however much was prepended and still not the top of the document.

**What it costs.** One forced layout per column per frame: `restoreScroll` reads `scrollHeight` or a
rect, which flushes the pending style change from `replaceChildren`. Three per frame at 4 Hz, on a
document of a few hundred nodes, in a window that is off by default and opened on purpose.

**The anchor offset is recorded as a whole pixel, and that is not a rounding convenience.** A tick
renders 165.5 px tall and a Chromium scroll offset is snapped to a whole pixel, so a row that tall
cannot be scrolled past exactly: half of every correction is unspendable. Restoring against wherever
the previous frame *landed* loses that half each time, which measured 0.5 px per frame — 120 px down
the screen over 240 frames, one minute at 4 Hz. Rounding the recorded offset makes each frame aim at
the same whole number instead, so the error oscillates inside one pixel rather than accumulating.
This was found in a real Electron window and could not have been found in `happy-dom`, which stores
a fractional `scrollTop` quite happily; `scroll.test.ts` now models the snapping and reproduces the
same 120 px when the rounding is removed.

`overflow-anchor: none` is set on `.ins-column`. Chromium's own scroll anchoring is a second opinion
applied during a later layout, and with the whole subtree replaced every frame the two have nothing
to agree on — a reader watching a row drift could not tell which one moved it.

**What it forecloses.** Anchoring is only as good as the keys, so a panel that adds a repeated row
without a `data-ins-key` degrades quietly to the old behaviour for readers parked on it. `view.ts`
carries the rule in its header as the third of three, and `app.test.ts` asserts that every key in a
drawn document is unique — which is the assertion that fails when a new row borrows an existing
name.

**What it does not fix.** Text selection still does not survive a redraw. That, and reading a value
that is being replaced four times a second, is what the freeze button is for; freeze is now about
the values rather than about the scrollbar.

## Alternatives rejected

**Save and restore `scrollTop`.** Three lines, and it is what the ticket literally asks for. It
holds only for a list that grows downward, and the three panels that grow here do not — so it
converts a jump to the top into a steady drift, which is harder to describe and no easier to read
through.

**Keyed reconciliation of the whole document.** Would preserve scroll, selection and focus together,
and is the thing ADR-0032 declined on purpose: a stale node surviving because its key did not change
is a bug this window cannot afford, and it is exactly the failure mode a debug tool cannot detect
about itself. Persisting five nodes with fixed identities is the smallest version of the idea that
buys the outcome without the risk.

**`scrollIntoView` on the anchor.** Simpler to write and it moves the nearest scrollable ancestor
by an amount the browser chooses, with its own idea of where "into view" is. The anchor here has to
land at the same height it was at, not merely be visible again, and the arithmetic for that is two
lines.

**Diffing frames in main and sending patches.** Would shrink the redraw to the changed rows and fix
selection as well. It also puts a diff between the hub and the window, and the whole argument for
whole frames is that a frame is a few kilobytes and the window's only job is to be believed.

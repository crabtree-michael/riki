---
name: overlay-ui
description: The Riki desktop shell — overlay chip, tray icon, global hotkey and settings in `apps/desktop`. Covers the state model, colour tokens and the no-red rule, the 100 ms visibility budget, reduced motion and high contrast, click-through window rendering, and the preload boundary. Use when working on any visible surface, the push-to-talk gesture, or window behaviour.
---

# The overlay, tray and hotkey

The product promise is *invisible until needed*, and this is the area where that is literal.
Hidden must render **no window at all** — idle costs nothing, and a test asserts it.

## Rules that hold

- **No red.** Red means "you are dying" in Dota's own HUD; Riki's states must never compete
  with the game's alarm colours. A token lint rejects `#FF0000`-family values in the accent
  palette.
- **Colour is never the only channel.** Every state has a distinct glyph *and* a distinct
  motion signature, asserted exhaustively over the state enum. This covers colour-blind
  players and anyone glancing at a 24 px chip mid-fight.
- **No raw colour literals in renderer code.** Accents come from the token module, so "no
  red" has exactly one place to be enforced.
- **≤100 ms from key-down to chip visible.** Below that the overlay feels like part of the
  key press; above it, it feels like lag. This is an e2e assertion, not an aspiration.
- **Captions default off**, and the default is asserted by test — a streamer must not
  discover on-screen transcripts live.
- **Reduced motion and high contrast are variants of every state**, not a global disable.

## Structure

- **The interaction state machine is in `main/session`, not in the renderer** (ADR-0009). The
  chip and the tray are two projections of one state; earcons and ducking are its effects. The
  renderer holds presentation state only — animation phase, level ballistics, fade. Start from
  `docs/design/overlay-architecture.md`; it carries the class and method signatures.
- **The component is implemented**: `main/session` (machine, runtime), `main/overlay` (window
  controller, presenter, placement, level pump), `preload/overlay-bridge.ts`, `renderer/overlay`
  (chip, motion, ballistics, tokens). Fakes for every injected seam are in `main/testing/fakes.ts`
  and chip models for renderer tests in `renderer/overlay/testing/models.ts` — use them rather than
  writing new ones.
- **Nothing launches it yet.** There is no app entry, no bundler, no `pnpm build`/`dev`, and no
  Tier 5 harness, so the chip has never been rendered on a screen and every claim in §12 of the
  design doc is still unverified. `index.html` expects a compiled `index.js` beside it; the build
  that produces one belongs to the `apps/desktop` shell.
- **The chip can carry no clickable affordance.** `setIgnoreMouseEvents(true)` means the window
  receives no pointer event at all, so `Esc ✕`, `Fix ▸` and `[Y] yes` in `ui-design.md` §5.1 are
  keyboard hints rendered as text, not buttons. Confirming gets scoped `Y`/`N` accelerators that
  are released the moment it exits — a permanently grabbed `Y` eats a game binding.
- The overlay is a click-through layered window with per-pixel alpha. Always-on-top plus a
  global hook is exactly the combination anti-cheat systems scrutinise — the anti-cheat
  spike is a blocking risk and must precede real depth here.
- **Renderer code may not import from `main/`.** The preload bridge is the only path,
  `contextIsolation` stays on, and no Node reaches the renderer. A lint boundary enforces it.
- Push-to-talk is the default trigger, with a tap/hold gesture. Detect hotkey conflicts at
  bind time rather than failing silently in-game.
- Multi-monitor and non-default HUD scales are normal cases here, not edge cases.

## Testing

Playwright against a real Electron build is the only place a window launches, so keep the
state machine itself pure and unit-tested; drive transitions in e2e, assert arithmetic in
unit tests.

## Learnings

**2026-08-01 — renderer code cannot name a DOM type yet.** `apps/desktop/tsconfig.json` is one
project with `lib: ["ES2023"]`, so `export type X = HTMLElement` is `error TS2304` — measured,
not inferred. Any view code you write against the DOM will not compile until step 6 splits the
app into `tsconfig.main/preload/renderer.json` with `lib: ["ES2023", "DOM"]` on the renderer only.
*Why:* it looks like a missing `@types` package and it is not; and the split is worth doing
properly, because it is also what turns "no Node in the renderer" into a type error instead of a
code review.

**2026-08-01 — the colour-token module cannot be TypeScript.** The `no-restricted-syntax` rule in
`eslint.config.js` rejects every hex literal under `apps/desktop/src/renderer/**` and has no
exemption for the token module itself, so a TS module holding `#6FD3FF` is rejected by the rule
that exists to protect it. Put the values in `tokens/tokens.css` as custom properties and export
only token *names* from TS. *Why:* the alternative is an eslint ignore for one file, which is
exactly the hole the rule was written to close — and CSS custom properties are where these values
are consumed anyway, which makes the high-contrast variant a class swap.

**2026-08-01 — Electron runs headless here, but only under `xvfb-run` *and* `dbus-run-session`.**
Verified on a bare Linux sandbox with a transparent, frameless, `setIgnoreMouseEvents(true)`
window — the actual overlay shape from `ui-design.md` §6.5 — on Electron 43 / Chromium 150:

```shell
xvfb-run -a dbus-run-session -- electron --no-sandbox main.js
```

Without `dbus-run-session` it still runs, but floods stderr with `Failed to connect to the bus`
and cannot reach `org.a11y.Bus`; anything touching the tray (StatusNotifier) or accessibility
needs a real session bus rather than just a display. A `ContextResult::kTransientFailure` GPU
line is expected on a machine with no GPU — Chromium falls back to software rendering and the
window still loads.

*Why:* the e2e harness is Playwright on a real Electron build (§5.3 Tier 5), and it will run on
exactly this kind of headless box. Debugging "Electron won't start" is much slower than knowing
the two wrappers up front. The apt libraries it needs beyond a base image are `libnss3`,
`libnspr4`, `libatk1.0-0t64`, `libatk-bridge2.0-0t64`, `libatspi2.0-0t64`, `libcups2t64`,
`libdrm2`, `libgbm1`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`,
`libxrandr2`, `libxshmfence1`, `libx11-xcb1`, `libgtk-3-0t64`, `libasound2t64`, plus `xvfb`
and `dbus-x11`.

**2026-08-01 — the `tsconfig` split is done, and it is what catches renderer leaks.** `apps/desktop`
is now a solution over five projects (`shared`, `main`, `preload`, `renderer`, `test`). Three things
that only show up once you are in it:

- `include` globs must be **disjoint**. Under `tsc --build` a file belongs to exactly one project,
  and an overlap is a duplicate-input error, not a merge.
- The renderer has `types: []` on purpose. `HTMLElement` resolves, `process` does not — verified in
  both directions with a throwaway file. Don't "fix" a missing Node type there by adding `node`.
- Cross-project imports need the project in `references`, and this is the rule that caught the real
  bug: the renderer importing `preload/overlay-bridge.js` for the `RikiOverlayBridge` type would
  have pulled `electron` into the renderer. The bridge's *type* now lives in `shared/overlay.ts`,
  and `preload/**` is on the renderer's lint disallow list next to `main/**`.

*Why:* the compiler found this before the lint did, and it is the kind of leak that looks harmless
in review — you are only importing a type.

**2026-08-01 — `boundaries/external` cannot enforce the `@riki/*` rules, and passes while not doing
so.** §11.2 asks for "`main/session/**` may not import `@riki/realtime`". Written as a
`boundaries/external` rule it reports success and catches nothing, because that plugin only sees
imports that **resolve** — and a workspace package that is not a declared dependency of
`apps/desktop` does not resolve. `electron` *is* a dependency, so the `electron` half of the same
rule fires correctly, which makes the failure even easier to miss. Use `no-restricted-imports` with
a `group` pattern for cross-package rules; it matches the literal specifier and fires before anyone
adds the dependency.

Same shape as the `workspace` skill's first learning, one layer down, and worth knowing:
**`packages/world-model` → `@riki/realtime` in `eslint.config.js` has this bug today.** It was left
alone rather than changed from an overlay task, but it is decoration until someone converts it.

**2026-08-01 — `Millis` is main's clock, and the renderer cannot use it for anything.** The
elapsed counter was specified as `elapsedFromMs`, a start timestamp. The renderer has no access to
main's monotonic clock, so it has nothing to subtract that from. The field is now `elapsedMs`, a
duration measured by main, that the renderer counts on from. Anything crossing the bridge that
looks like a timestamp is probably a bug — send durations.

**2026-08-01 — "every state has a distinct motion signature" is not achievable, and should not be.**
Both `REPO_SKELETON.md` §5.4 and this design ask for a distinct glyph *and* motion per state. But
ui-design §4.3 defines Acting as "as Processing, plus a verb", and Confirming, Muted and a settled
Error are all static — so the signatures collide by design. The glyphs are pairwise distinct, and
the assertion that means what §4.3 intends is over the **(glyph, motion) pair**. Design doc updated;
don't re-derive this.

**2026-08-01 — `isStatic(signature)` cannot stop the clock on its own.** A settled Error is static;
the same signature 10 ms after entry is not. The motion module exports `settlesAtMs(signature)`
alongside the `MotionDirector` interface, and the composition root restarts the animation clock on
every state change so each signature animates from its own zero — without that, an Error entered
from Listening inherits Listening's elapsed time and skips its double-pulse entirely.

**2026-08-01 — renderer view code is testable at Tier 1 with `happy-dom`.** There is a
`desktop-renderer` Vitest project for `apps/desktop/src/renderer/**/*.test.ts` on the `happy-dom`
environment. It needs no game, microphone, GPU or window, so §5.2 still holds, and it covers the
things Tier 5 would otherwise be the only witness to: `scaleY`-only frames, captions off by
default, the clock actually stopping. Tier 5 is still the only place a *window* launches — assert
placement, pixels and the 100 ms budget there.

## See also

`docs/design/overlay-architecture.md` (module structure, class signatures, the seams);
ADR-0009 (machine in main), ADR-0010 (the hidden voice window);
`docs/design/ui-design.md` §3 (state model), §4.2–§4.3 (tokens, no-red, multi-channel),
§6 (triggering), §8 (perceptual budget), §9 (accessibility, streamers), §10 (rendering);
`REPO_SKELETON.md` §5.3 Tier 5, §6.2.

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
- **`pnpm dev` launches it, and there is still no Tier 5 harness.** The app entry, the asset copy
  and `scripts/bundle.mjs` all landed, so a window can be put on a screen — but nothing automated
  does it, so §12's claims are verified only as far as somebody has looked. The Learnings section
  below has a fifteen-minute recipe for looking.
- **The chip can carry no clickable affordance.** `setIgnoreMouseEvents(true)` means the window
  receives no pointer event at all, so `Esc ✕` and `Fix ▸` in `ui-design.md` §5.1 are keyboard
  hints rendered as text, not buttons.
- **Seven states, not nine.** ADR-0023 deleted `Acting` and `Confirming` along with command
  execution, and with them `ActingVerb`, `ConfirmPrompt`, the amber `confirm` accent, the `confirm`
  affordance and intent, the `confirm-timeout` timer, and the `keys` effect and its scoped
  `Y`/`N`/`Esc` grab. **Riki now has no state that needs the keyboard for anything but the
  push-to-talk binding, and no permission prompt anywhere.** If you find a reference to either
  state in a doc, it predates ADR-0023 — fix it.
- **Every phase is reached from a key press.** ADR-0042 removed the `unprompted` machine input —
  Idle → Speaking with no gesture behind it — and `Phase.speaking` lost the boolean that
  distinguished the two. `turn.responseStarted` while Idle is now *ignored*, deliberately: a
  response with no phase behind it means something created one the gesture did not, and inventing a
  chip for it would have the overlay claim the player asked something they did not. The one thing
  that can still do that is the inspector's `scenario.speak`, which plays with the chip hidden.
- The overlay is a click-through layered window with per-pixel alpha. Always-on-top plus a
  global hook is exactly the combination anti-cheat systems scrutinise — the anti-cheat
  spike is a blocking risk and must precede real depth here.
- **Renderer code may not import from `main/`.** The preload bridge is the only path,
  `contextIsolation` stays on, and no Node reaches the renderer. A lint boundary enforces it.
- **The inspector is the one renderer that can change the app** (ADR-0039), and it does it through a
  registry in `main/debug/actions.ts` rather than through a wider bridge. If you need a new scenario
  exposed there, add a row — do not add an intent. `parseDebugIntent` checks *shape*; main checks
  whether the id is registered and not already running, and the two are deliberately not the same
  check. ADR-0037's settings registry is gone with the thresholds it moved (ADR-0042).
- Push-to-talk is the default trigger, with a tap/hold gesture. Detect hotkey conflicts at
  bind time rather than failing silently in-game.
- Multi-monitor and non-default HUD scales are normal cases here, not edge cases.

## Testing

Playwright against a real Electron build is the only place a window launches, so keep the
state machine itself pure and unit-tested; drive transitions in e2e, assert arithmetic in
unit tests.

## Learnings

**2026-08-09 — a CSS rule you cannot see is not a mark, and 90 seconds of Electron settles it.**
ADR-0047's no-tool-call flag was a red 2px `border-left` on `.ins-turn`, which is exactly right in
the source and **invisible on screen**: a turn fills its panel, so the border lands on the column
divider and reads as part of it. Every Tier 1 test passed, because a test can assert a class name
and cannot see. The check that found it, and the reason it is cheap enough to be routine:

```sh
# a throwaway *.test.ts in src/renderer/debug/ that mounts the view against a realistic frame
# and writes `<style>${css}</style>${document.body.innerHTML}` to /tmp/inspector.html
pnpm exec vitest run --project desktop-renderer <the probe>
xvfb-run -a node_modules/.pnpm/electron@*/node_modules/electron/dist/electron /tmp/shot.mjs
```

`shot.mjs` is ten lines: `app.whenReady().then(...)`, a `BrowserWindow` with
`webPreferences: { offscreen: true }` and `show: false`, `loadFile`, `capturePage()`,
`writeFileSync(png)`. **No app boot, no preload, no IPC** — the view is pure and the stylesheet is a
file, so the whole visual layer can be photographed without the composition root. It also caught a
`grid-template-columns` still declaring three columns after ADR-0042 left two, which had been
shipping as dead space.

*Why:* the `run` recipes in this repo all boot the app, which is right for wiring and far too
expensive to repeat while iterating on a colour. Delete the probe before committing — it is a
measurement, not a fixture.

**2026-08-04 — the inspector can run two scenarios now, and the panel worth having is the *trace*
(ADR-0039).** `main/debug/actions.ts` is a second registry beside `controls.ts` — a control is a
value you move, an action is something you start, and ADR-0037 admitted the first while explicitly
refusing the second, so they are kept apart rather than folded into one row type. Two rows,
`scenario.match` and `scenario.speak`; a third needs an ADR.

Three things learned building it, each of which cost a cycle:

- **The `controls.ts` header says "Force a tick", "say this now" are deliberately unreachable.**
  Read it before adding anything that *does* something to that file. Reversing it was fine; doing so
  without noticing would have left the file contradicting itself.
- **A scenario's GSI frames cannot skip ahead.** `packages/gsi` raises `clock_discontinuity` when a
  frame's clock differs from the previous one extrapolated by wall time by more than 5 s, and a
  discontinuity resyncs the world model — clearing the latch set and cooldowns the run exists to
  exercise. 2 game seconds per 500 ms is safe; a jump from pre-game straight to 2:30 is not, which
  is why the script walks continuously and why it aims at the **0:53 stack** rather than the 3:00
  bounty (a continuous walk to the bounty is 45 s of button).
- **A caption keyed on an equality that cannot hold is a silent nothing.** The script steps the
  clock by 2 from an even number and the stack is at an odd one, so `until === 12` never fired.
  Both notes are boundary crossings now, and a test asserts all four actually appear — the compiled
  script printed two of four, which is how it was caught.

**The load-bearing half is not the buttons.** `main/index.ts` passed `createVoiceSession` four no-op
telemetry arrows, so no session fault reached the hub and the Problems panel's silence read as
"nothing failed". They now forward into the hub's trace, late-bound because the session is built
before the shell that owns the hub. Every panel in this window is *state* — "what is true now" —
and the failure in the `voice-realtime` skill's 2026-08-04 entry was invisible to all of them
because the only useful question was "what happened, in order, and where did it stop".

**2026-08-02 — drive a real window from a throwaway `main.mjs`; it is fifteen minutes and it is the
only thing that checks the renderer↔main round trip.** Every window in this app is Tier-5-untested
(there is no Playwright harness), and unit tests cover both halves of a bridge and never its
installation. This works, headless, and produces a screenshot:

```sh
mkdir -p /tmp/probe && cat > /tmp/probe/package.json <<'EOF'
{ "name": "probe", "version": "0.0.0", "main": "main.mjs", "type": "module" }
EOF
# main.mjs: app.whenReady().then(async () => { ... }) — never a top-level await (workspace skill)
xvfb-run -a -s "-screen 0 1400x1000x24" \
  node_modules/.pnpm/electron@*/node_modules/electron/dist/electron --no-sandbox /tmp/probe
```

Inside it, `await import('<repo>/apps/desktop/dist/main/debug/index.js')` gives you the real
factories, and `webContents.executeJavaScript(...)` is how you *act* as the user —
`document.querySelector('[data-focus="…"]').click()` goes through the real preload, the real IPC
channel and the real allow-list. `webContents.capturePage()` then writes a PNG you can actually
look at, which is what caught that every Controls row was four lines tall. Write results to a file:
main's `process.stdout` does not survive the `xvfb-run` pipe. Build first — `pnpm typecheck &&
pnpm assets && pnpm bundle` — because it drives `dist/`, not `src/`.

*Why:* this is how the inspector's one unverified hop (main → renderer over IPC) got verified, and
how the stale ⚠ in `debug-inspector.md` §9 was found to have been fixed by ADR-0034 two commits
earlier. Nothing in the test suite could have told you either.

**2026-08-02 — a document redrawn whole cannot hold an `<input>`, and loses focus every frame.**
The inspector rebuilds itself at 4 Hz (ADR-0032), so the Controls panel (ADR-0037) is buttons only:
a text field being typed into has its value replaced mid-keystroke, and a stepper click is atomic.
Focus is the subtler half — a redraw replaces the node the user is standing on, so tabbing to a
control or holding a key down is impossible unless focus is restored by hand. Every actionable node
carries a `data-focus` key and `draw()` re-focuses the matching node afterwards; it is eight lines.

Three traps in those eight lines. `happy-dom` does **not** implement `CSS.escape`, so a naive
`querySelector` with a template key throws on the first redraw after a click and reads as a test
failure with no defect behind it. One delegated `click` listener on the root is worth writing rather
than per-node listeners, which would otherwise be created and discarded four times a second for the
life of the window. And restoring focus **must** pass `preventScroll: true` when anything else is
managing the scroll position: `focus()` scrolls its element into view in the nearest scrolling
ancestor, so a per-frame focus restore silently overrides a per-frame scroll restore that ran a line
earlier, and the reader is dragged back to whatever they last clicked. `happy-dom` moves
`document.activeElement` and scrolls nothing, so no Tier 1 test sees this unless it models the
scroll the way `app.test.ts`'s `modelFocusScrolling` does.

*Why:* it reproduces as "live updates reset my scroll position" — the complaint ADR-0036 already
fixed — so the obvious first move is to go looking in `scroll.ts`, where nothing is wrong.

**2026-08-02 — the overlay's preload script had never loaded, since the step that wrote it.**
Electron loads a preload as **CommonJS**; `apps/desktop/package.json` is `"type": "module"` and
`tsc` emits ESM, so `dist/preload/index.js` failed with `SyntaxError: Cannot use import statement
outside a module`. The error goes to the *renderer's* console, which nothing reads — main starts,
binds its socket and runs the whole state pipeline, and `window.rikiOverlay` is simply
`undefined`. Every unit test passed throughout, because they test the bridge's *modules*, never its
installation.

`scripts/bundle.mjs` now emits **every** preload as `.cjs` with `electron` external, and
`resolvePaths` points at those (ADR-0034). There are three — overlay, voice, inspector — and a
window whose preload is missing from that script's list fails the same invisible way, which is why
`test/repo-hygiene.test.ts` derives the check from `resolvePaths` rather than listing them. To see
it yourself:

```sh
cd apps/desktop && ELECTRON_ENABLE_LOGGING=1 xvfb-run -a ./node_modules/.bin/electron .
```

`ELECTRON_ENABLE_LOGGING=1` is the load-bearing part — it forwards renderer console output to
stderr, and without it the preload failure is invisible from the terminal. Use it for anything that
touches a renderer, and grep past the `dbus`/`Gtk`/`vaapi` noise a headless sandbox produces.

**2026-08-02 — there are two renderers now and they build differently.** `renderer/overlay/` is
hand-written ES modules loaded straight from `tsc` output; `renderer/voice/` imports workspace
packages and is bundled (ADR-0010, ADR-0034); `renderer/debug/` is like the overlay — its own
modules, no packages, unbundled. A `@riki/*` import added to the overlay fails at *run
time* with an unresolved bare specifier in a window nobody is looking at — which is why the
`no-restricted-imports` rule banning it is now scoped rather than deleted, and why its message names
both ADRs.

**2026-08-02 — a tray with a context menu has no left-click to spend.** `tray.setContextMenu(...)`
makes the icon open that menu on click, on every platform; macOS opens it on *either* button and
emits `click` as well. So `ui-design.md` §2.3's original "Left-click → toggle mute. Right-click →
menu" was not two gestures — it was one, and wiring mute to `click` meant every glance at the
status line toggled mute, with the menu that opened rendering the pre-toggle checkbox so the state
looked merely laggy. Fixed in ADR-0028: mute is the menu row only, and `TraySurface.onClick` is
gone rather than left unwired. *Why:* if you add a tray gesture, check what `setContextMenu`
already claims before assuming a button is free — and note that this class of bug survives its own
test suite. The test asserting it read `treats a left-click and the mute row as the same request`,
which is the bug written down as an expectation, and it passed.

**2026-08-02 — a port method with no subscriber cannot be regression-tested from below.** Once
`onClick` was off `TraySurface`, no test could call it, so "clicking does not mute" is unassertable
by construction. The guard that does work is one level up — proxy the surface, and assert the
controller subscribes to exactly `['onAction']`. *Why:* it fails on *any* re-added subscription
whatever it is wired to, which is the actual failure mode; verify it by reintroducing the wiring
and watching it go red, because a test written after a fix passes trivially either way.

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
Armed, Muted and a settled Error are all static, so the signatures collide by design. The glyphs
are pairwise distinct, and the assertion that means what §4.3 intends is over the **(glyph,
motion) pair**. Design doc updated; don't re-derive this.

*Update, same day:* ADR-0023's deletion of Acting removed the only collision between two states
that actually **animate** — Acting was "as Processing, plus a verb" and shared its sweep. The
remaining collisions are all `'none'`. The pair assertion is still the right one, and it is now
stronger than when it was written.

**2026-08-01 — deleting a chip state means deleting a *producer*, and the test that matters proves
nothing produces it.** Removing `Acting` and `Confirming` touched fourteen files across main,
preload, renderer and shared, and the compiler found all but one class of thing: a state whose
union arm is gone still leaves an orphan colour token, an orphan glyph in `overlay.css`, and an
orphan row in a `Record<ChipState, …>` in the *renderer* that duplicates main's. Grep for the
state name across `.ts`, `.css` and `.md` — the CSS and the docs do not typecheck. Then write the
assertion in the form that survives: `machine.test.ts` now drives **every input against every
reachable phase** and asserts the deleted phases are never entered and no `keys` effect is ever
emitted. *Why:* a deleted state that something can still reach is indistinguishable from a working
one until a player finds it, and "I removed the type" is not evidence that nothing produces it.

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

**2026-08-01 — `warm()` deadlocked on an event that had already fired, and nothing said so.**
`OverlayWindow.load()` did `await win.loadFile(...)` and *then* subscribed to `ready-to-show`.
`loadFile` resolves on `did-finish-load`, which arrives **after** `ready-to-show`, so the promise
never settled, `shell.start()` never returned, and the app sat there with a tray icon and no GSI
listener. Subscribe before `loadFile`, and race the wait against a timeout
(`FIRST_PAINT_TIMEOUT_MS`) so a renderer that never paints degrades to a cold `showFast()` rather
than to an app that never finishes starting.

*Why:* an unresolved promise is indistinguishable from a slow start, and the two `once` listeners
looked so obviously right that the bug survived every review of that file. Found in the first
thirty seconds of the first real `pnpm dev`, and findable no other way — there is no unit test that
can catch an ordering fact about Electron's own events. **Run the app.**

**2026-08-01 — `globalShortcut` cannot do push-to-talk, and this is now load-bearing rather than
theoretical.** ui-design §6.4 says it; the shell now depends on it. There is no key-*up* from
`globalShortcut`, so `electron-hotkey.ts` synthesises both edges at one instant and the recognizer
reads every press as a tap. **Tap-to-latch works; hold-to-push does not**, everywhere, until
someone writes a `CGEventTap` behind `KeySource` — and the anti-cheat spike has to clear first.

The related trap is in the *machine*, not the platform: `session/machine.ts` decides push-versus-
latch from the **first** trigger event of a gesture and has no edge that promotes one to the other.
So a recognizer cannot emit `down` optimistically at key-down and correct itself at 250 ms; it has
to wait until it knows. That puts overlay §9.1's "t+0 key-down → visible" on the wrong side of
§6.2's threshold for a held key — ≤100 ms after a tap, ≤350 ms after a hold — and **neither
document acknowledges the interaction.** Named in `trigger/recognizer.ts`'s header rather than
quietly resolved, because resolving it means giving up tap-to-latch or changing the state table.

**2026-08-01 — the four tray glyphs are generated, and macOS needs them to be template images.**
`scripts/generate-tray-glyphs.mjs` writes `apps/desktop/resources/tray/*Template.png` as raw PNG
bytes (zlib + a CRC; no image dependency for eight 16×16 files). Two halves, and the second is the
one that is easy to miss: the filename must end in `Template` **and** `nativeImage.setTemplateImage(true)`
must be called. Without the flag AppKit draws the black pixels literally, which is invisible in
dark mode — and a menu-bar icon nobody can see reads as an app that did not start.

**2026-08-02 — ⚠ the preload bridge has never loaded, and `window.rikiOverlay` does not exist.**
Measured, not inferred: launch a `BrowserWindow` with `preload: dist/preload/index.js` and the
overlay document, subscribe to `webContents.on('preload-error')`, and it fires with
`Cannot use import statement outside a module`. `Object.keys(window).filter(k => k.startsWith('riki'))`
is `[]`. So `renderer/overlay/index.ts`'s `start()` takes its `bridge === undefined` early return on
every launch, the chip has never drawn in a real window, and **no test can see it** — the renderer
tests inject a fake bridge and there is no Tier 5 harness.

Two causes stack, and fixing either alone is not enough:

- `apps/desktop/package.json` is `"type": "module"`, so `tsc` emits `dist/preload/*.js` as ESM.
  Electron loads preload scripts as CommonJS. Setting `module: CommonJS` in `tsconfig.preload.json`
  (plus `verbatimModuleSyntax: false`, and a `dist/preload/package.json` of `{"type":"commonjs"}`)
  does produce CJS — and then you hit the second cause.
- **A sandboxed preload must be a single self-contained file.** With `sandbox: true` the preload
  loader gives you a subset of Node and *no relative `require`*: the CJS build fails with
  `module not found: ./overlay-bridge.js`. Both preloads import a sibling and two `shared/` value
  modules (`channels.js`, `intents.js`), so neither can ever load unbundled.

So this needs a **preload bundling step**, which REPO_SKELETON.md §8.1 defers to "when Vite lands".
The three routes, none of them free: bundle preload (correct, adds the build dependency the repo
deliberately has not taken); make each preload self-contained by inlining the channel names and the
intent allow-list (cheap, but duplicates the allow-list that exists specifically to be checked at
two boundaries); or `sandbox: false`, which Electron does allow ESM preloads under and which gives
up a security property overlay-architecture.md §6.2 requires — not acceptable.

*Why:* this is invisible from every direction. `pnpm dev` starts cleanly, the window warms, the
tray works, `pnpm check` is green, and the only symptom is a chip that never appears — which reads
as "the turn path did not fire" rather than "the renderer has no bridge". Do not spend the time
twice: reproduce it in ten seconds with a `preload-error` listener before assuming your feature is
what broke.

**2026-08-02 — a renderer whose behaviour *is* layout cannot be finished in `happy-dom`, and the
window that finishes it costs ten minutes.** The inspector's scroll fix (ADR-0036) passed 38 Tier 1
tests and was still wrong: rows are 165.5 px tall, Chromium snaps a scroll offset to a whole pixel,
and restoring the anchor against wherever the last frame landed silently lost half a pixel per
frame — 120 px down the screen over a minute at 4 Hz. `happy-dom` cannot show you this, because it
reports every rect as zero and stores a fractional `scrollTop` quite happily; the stubs a Tier 1
test writes agree with whatever the code believes.

The check that found it, and it is reusable for any renderer question that is really a layout
question — no Playwright, no harness, about fifteen lines:

```sh
pnpm typecheck && node scripts/copy-renderer-assets.mjs   # dist/renderer/<name>/ is now loadable
# a throwaway page beside it that `import`s the compiled module, drives it, and sets window.__result
xvfb-run -a --server-args="-screen 0 1920x1080x24" \
  node_modules/.pnpm/electron@*/node_modules/electron/dist/electron /tmp/harness
# main.cjs: BrowserWindow → did-finish-load → executeJavaScript('window.__result') → writeFileSync
```

Three things that save a cycle each. Put the throwaway page **in `dist/renderer/<name>/`** so its
relative `import './app.js'` and stylesheet resolve exactly as the real document's do — and skip the
CSP meta, or the module will not load. Use `.cjs` under a `/tmp` directory with its own
`package.json` for the Electron main, which sidesteps the top-level-`await` deadlock the `workspace`
skill warns about. And **measure across hundreds of frames, not two**: the two-frame result looked
perfect, and the drift only named itself at 240.

*Why:* the renderer tests here are worth having and they are not sufficient for anything geometric.
Budget the ten minutes; the alternative is shipping a fix for a jump that turns it into a crawl.

**2026-08-09 — the chip and the turn are two halves of a gesture, and only one of them was wired.**
The trigger pump dispatched into the machine and the machine drove the chip; nothing translated the
resulting phase transitions into `beginPlayerTurn`/`endPlayerTurn`, so the overlay showed a turn
that reached no session. It is `shell/index.ts`'s `runtime.subscribe` block now, and the shape to
keep is that **the machine's phase is the source of truth, not the key events** — push ends on
release, latch ends on the next tap, server VAD can end a turn with the key still held (ADR-0017),
and a barge-in enters Listening with no Armed. Reading key events there is a second copy of all
four rules. *Why:* the one edge that is easy to get wrong is `armed → listening`, which is the
microphone opening rather than the gesture ending — treating it as an end cancels every turn a
millisecond after it starts, and the chip still looks perfect.

## See also

`docs/design/overlay-architecture.md` (module structure, class signatures, the seams);
ADR-0009 (machine in main), ADR-0010 (the hidden voice window);
`docs/design/ui-design.md` §3 (state model), §4.2–§4.3 (tokens, no-red, multi-channel),
§6 (triggering), §8 (perceptual budget), §9 (accessibility, streamers), §10 (rendering);
`REPO_SKELETON.md` §5.3 Tier 5, §6.2.

# Riki — Voice Agent UI/UX Design

> *Riki is invisible until needed.*

This document specifies the visible surface of the Riki voice agent: where it lives, what
it shows, how it is triggered, and what it feels like in the middle of a game.

## 0. Assumptions

The repository is currently a stub, so this design is written against the following
assumptions. Flagging them here because several downstream decisions depend on them; if
any are wrong, the sections marked ⚑ are the ones that change.

| # | Assumption | Affects |
|---|---|---|
| A1 | Riki is a desktop companion app that runs alongside full-screen / borderless games | ⚑ §2 Surfaces |
| A2 | Interaction is voice-in → voice-out, and the agent can also *take actions* (not just answer) | ⚑ §3 State model |
| A3 | macOS is the primary target for players; Linux is the dev platform; Windows is a later target | ⚑ §6.4 Hotkey capture |
| A4 | Speech recognition and/or inference may be remote, so multi-second latency is possible | ⚑ §8 Timing |
| A5 | A meaningful share of users stream or record their gameplay | ⚑ §9.3 Streamers |

---

## 1. Design principles

1. **Zero pixels at rest.** Idle is not a dim icon or a small dot — it is *nothing rendered*.
   Every other decision defers to this. The overlay window does not exist until a session starts.
2. **Motion means Riki is working. Stillness means Riki is waiting on you.** One learnable
   rule that lets a player read state from peripheral vision without parsing colour or text.
3. **Never impersonate the game's HUD.** Riki must read as *not part of the game* — different
   shape language (rounded chip), different palette, no red.
4. **Peripheral-legible, never attention-stealing.** The player is looking at screen centre.
   The indicator must be detectable at the edge of vision and ignorable once read.
5. **Text is a last resort.** Reading costs foveal attention. Text appears only for errors,
   confirmations, and opt-in captions.
6. **Fail loudly, but only once.** A broken mic must be obvious. A broken mic must not nag
   every frame for the rest of the session.

---

## 2. Surfaces: where the indicator lives

**Decision: two surfaces with strictly separated roles.** This is the core structural call —
the tray and the overlay are not redundant, they answer different questions.

| Surface | Answers | Lifetime | Visible in full-screen games |
|---|---|---|---|
| **System tray icon** | *"Is Riki installed, running, and permitted?"* | Always, while the daemon runs | ✗ No |
| **In-game overlay chip** | *"What is Riki doing right now?"* | Only during a session | ✓ Yes |

### 2.1 Why not tray-only

The tray is invisible the moment a game goes full-screen — which is exactly when Riki is used.
A tray-only design gives the player no feedback during the interaction that matters. It also
cannot show a live mic level, and *"am I actually being heard"* is the single most common
failure mode in voice UX.

### 2.2 Why not overlay-only

Without a persistent surface there is nowhere to answer "is Riki even on?" before you launch
a game, nowhere to surface a revoked microphone permission, and no way to quit. The tray is
the control surface; the overlay is the feedback surface.

### 2.3 Tray icon spec

Monochrome glyph, follows OS light/dark. Four tray states only — the tray does **not** mirror
the fine-grained session states, because glancing at the tray mid-sentence is not a real
behaviour:

```
 ◇   idle          outline glyph, running and ready
 ◆   active        filled glyph, a session is in progress
 ⊘   muted         user has explicitly disabled Riki
 !   attention     mic permission revoked / no audio device / auth expired
```

Left-click → toggle mute. Right-click → menu:

```
 ┌──────────────────────────────┐
 │  Riki — ready                │   status line, non-interactive
 ├──────────────────────────────┤
 │  Mute Riki            ⌥⌘M    │
 │  Overlay position          ▸ │
 │  Input device              ▸ │   live level meter inline
 │  Per-game profiles…          │
 ├──────────────────────────────┤
 │  Settings…                   │
 │  Quit Riki                   │
 └──────────────────────────────┘
```

### 2.4 Overlay placement ⚑

The overlay is a click-through, always-on-top, per-pixel-alpha window. Placement has to
survive genres whose HUDs occupy completely different regions, so *no single default is
correct everywhere*. Observed HUD occupancy:

```
┌────────────────────────────────────────────────────────────────┐
│ minimap · quests    ROUND TIMER · SCORE      buffs · minimap    │  ← busy in FPS
│                                                                │
│                                                                │
│                                                                │
│                              ✛  crosshair                      │  ← never touch
│                                                                │
│                                                                │
│                                                                │
│ chat · health         hotbar · ammo            killfeed · ammo  │  ← busy in MMO/MOBA
└────────────────────────────────────────────────────────────────┘
```

**Default anchor: top-centre, docked to the top edge, 12 px inset.** It is the closest region
to the crosshair that is not the crosshair, which makes it detectable in peripheral vision with
the smallest possible saccade cost, and it is empty in the majority of non-competitive titles.

**Shipped per-genre overrides**, because top-centre collides with the round timer in
competitive shooters:

| Genre | Anchor | Reason |
|---|---|---|
| Default / desktop | Top-centre | Nearest sparse region to gaze |
| Competitive FPS | Top-left, below minimap | Round timer and score own top-centre |
| MOBA | Top-centre | Bottom third is entirely HUD |
| MMO | Top-centre | Chat bottom-left, action bars bottom-centre |
| Racing / sim | Top-centre | Instrument cluster is bottom-heavy |

Users get 8 anchor presets plus drag-to-place with a live preview, stored per-executable.
Detected game → profile mapping is a convenience only; the manual override always wins.

---

## 3. State model

Seven states. Five are session states, two are persistent conditions.

| State | Trigger | Motion | Colour | Text |
|---|---|---|---|---|
| **Hidden** | No session | — (not rendered) | — | — |
| **Armed** | Hotkey down, pre-roll buffer filling | none | cyan, outline only | — |
| **Listening** | Capturing speech | live amplitude bars | cyan | — |
| **Processing** | Utterance sent, awaiting response | indeterminate loop | violet | — |
| **Speaking** | TTS playing | output envelope bars | mint | — |
| **Error** | Mic denied, offline, ASR/model failure | one double-pulse, then static | coral | required |
| **Muted** | User disabled Riki | none | grey | — |

> **There were nine, and ADR-0023 removed two.** **Acting** existed for a tool call slow enough to
> need its own pixels and **Confirming** for the consent gate in front of `read_screen`. Command
> execution is deleted: the facts a turn needs are assembled in-process, under 5 ms, before the
> model is asked to speak, so nothing is slow enough to need pixels and nothing needs permission.
> A state with no producer keeps its tests, keeps its colour token and is never entered, which is
> the worst of both — so both went with their producers. See coaching-architecture.md §7.2.
>
> What replaces them is nothing. A coaching turn is **Speaking** with `unprompted: true` (§9.3 of
> overlay-architecture.md), which is now the most common thing the chip does.

Notes on the non-obvious entries:

- **Armed** exists to close the ~100 ms gap between key-down and the audio pipeline being hot.
  Without it, the overlay appears *after* the user has started talking, and the first word gets
  clipped with no indication of why. Pre-roll buffering means audio from before the key press
  is retained; Armed tells the user the chip is alive even though the bars have not moved yet.
- **Muted** is the sole exception to "zero pixels at rest": if the user disabled Riki and we
  render nothing, the next PTT press produces silence indistinguishable from a crash. Muted
  renders a small static grey dot, at 40 % opacity, in the anchor position.

### 3.1 Transitions

```
                    ┌────────────────────────────────────┐
                    │                                    │
   Hidden ──PTT──► Armed ──audio──► Listening ──release──► Processing
      ▲                │                 │                     │
      │                │             timeout(8s)               │
      │                │                 │                     │
      │                └──cancel─────────┴──► Cancelled        │
      │                                        │               │
      │                                        ▼               ▼
      └───────── fade-out(400ms hold) ◄──── Speaking ◄──────────┘
                          ▲     ▲              │
                          │     │         barge-in
       coaching trigger ──┘     └── Error ◄─── (any state, on failure)
```

The one entry with no gesture behind it is the coaching trigger: Hidden → Speaking directly, no
Armed and no earcon (ADR-0023, overlay-architecture.md §9.3).

- **Barge-in:** speaking on the hotkey while Riki is in **Speaking** cancels TTS and returns to
  **Listening** in a single gesture. This is the most important interaction in the whole design —
  a voice agent you cannot interrupt is unusable in a game.
- **Cancel:** `Esc` from any active state returns to Hidden without executing.
- **Listening timeout:** 8 s of continuous capture with no speech detected → Error ("didn't
  catch that"), not a silent drop.

---

## 4. Visual specification

### 4.1 Geometry

```
     ├────────────── w: 32 → 180 px (content-driven) ─────────────┤
     ╭─────────────────────────────────────────────────────────╮  ┬
     │   ●        ▂  ▅  █  ▆  ▃                                │  │ h: 28 px
     ╰─────────────────────────────────────────────────────────╯  ┴
      └12┘└10┘ └10┘└─ 5 bars × 3 px, 2 px gap ─┘           └12┘

   corner radius : 14 px (fully round)
   status dot    : 10 px ⌀
   bar height    : 4 → 18 px, driven by RMS
   width change  : animated, 160 ms, ease-out — never snaps
```

Overlay scale is a user setting (0.75× / 1× / 1.25× / 1.5×) and defaults from OS display
scaling. All values above are logical pixels at 1×.

### 4.2 Colour tokens

```
  chip.bg          rgba( 12,  14,  18, 0.72)   near-black, translucent
  chip.border      rgba(255, 255, 255, 0.14)   1 px hairline — reads on dark backgrounds
  chip.shadow      rgba(  0,   0,   0, 0.45)   0 2 8, keeps it off bright scenes

  accent.listening #6FD3FF   cyan
  accent.working   #B9A8FF   violet
  accent.speaking  #7EE8B0   mint
  accent.error     #FF8A7A   coral
  accent.muted     #8A93A6   grey
```

Two rules behind these choices:

- **No pure red, ever.** In a game, saturated red at the screen edge is the near-universal
  signal for *taking damage* or *low health*. An error chip in `#FF0000` will be misread as a
  game event and will spike the player's heart rate for no reason. Coral is unmistakably
  "notification" rather than "damage".
- **The chip must be legible on both a snowfield and a night level.** A translucent dark chip
  with a light hairline border satisfies both; a light chip or a border-less dark chip does not.
  Optional 8 px backdrop blur improves this further but is disabled by default (see §10).

### 4.3 Colour is never the only channel

Every state is distinguishable without colour vision, by motion signature and glyph:

| State | Motion signature | Glyph |
|---|---|---|
| Listening | bars, amplitude-driven, irregular | `●` filled dot |
| Processing | bars, sweeping, regular 1.2 s loop | `◍` segmented dot |
| Speaking | bars, envelope-driven, irregular | `◉` ringed dot |
| Error | double-pulse then static | `!` |
| Muted | static, 40 % opacity | `⊘` |

---

## 5. Wireframes

### 5.1 Per-state

```
HIDDEN                              nothing rendered; no window, no compositor cost



ARMED                               ≤120 ms, dot outline only, bars absent
    ╭──────────╮
    │    ◌     │
    ╰──────────╯


LISTENING                           5 bars, live mic RMS @ 30 fps
    ╭──────────────────────────╮
    │   ●     ▂  ▅  █  ▆  ▃    │
    ╰──────────────────────────╯


LISTENING · silence > 1.2 s         bars flatten, chip dims to 60 % — "we hear nothing"
    ╭──────────────────────────╮
    │   ●     ▁  ▁  ▁  ▁  ▁    │
    ╰──────────────────────────╯


PROCESSING                          bars sweep L→R, 1.2 s loop, no real data
    ╭──────────────────────────╮
    │   ◍     ▃  ▅  ▃  ▂  ▁    │
    ╰──────────────────────────╯


PROCESSING · > 2.5 s                elapsed counter appears, reassures rather than hangs
    ╭──────────────────────────────────╮
    │   ◍     ▃  ▅  ▃  ▂  ▁     3s     │
    ╰──────────────────────────────────╯


PROCESSING · > 10 s                 cancel affordance surfaces
    ╭────────────────────────────────────────────╮
    │   ◍     ▃  ▅  ▃  ▂  ▁    11s   ·  Esc ✕    │
    ╰────────────────────────────────────────────╯


ACTING                              short verb only; never a sentence
    ╭────────────────────────────────────╮
    │   ⚙     ▃  ▅  ▃  ▂  ▁   sending…  │
    ╰────────────────────────────────────╯


CONFIRMING                          static. amber. the only state that blocks.
    ╭──────────────────────────────────────────────────╮
    │   ?   Delete 42 files?      [Y] yes   [N] no     │
    ╰──────────────────────────────────────────────────╯


SPEAKING                            bars driven by TTS output envelope
    ╭────────────────────────────────────────╮
    │   ◉     ▅  ▂  ▆  ▃  ▁    ⌥Space ✕      │
    ╰────────────────────────────────────────╯
                                    hint fades after first 2 uses, then hidden forever


ERROR                               one double-pulse, then static for 4 s, then fade
    ╭──────────────────────────────────────────╮
    │   !   Microphone blocked         Fix ▸   │
    ╰──────────────────────────────────────────╯


MUTED                               persistent, 40 % opacity, no motion
    ╭──────────╮
    │    ⊘     │
    ╰──────────╯
```

### 5.2 In-game context — default anchor, Listening

```
┌────────────────────────────────────────────────────────────────┐
│                    ╭──────────────────────╮                    │
│  ┌──────┐          │  ●   ▂ ▅ █ ▆ ▃       │         ▣ ▣ ▣      │
│  │ map  │          ╰──────────────────────╯         buffs      │
│  └──────┘                                                      │
│                                                                │
│                                                                │
│                              ✛                                 │
│                                                                │
│                                                                │
│                                                                │
│  ▤ chat                                              27 │ 120  │
│  ▤                    ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢                 ammo   │
└────────────────────────────────────────────────────────────────┘
```

### 5.3 In-game context — competitive FPS profile, Processing

Shifted to top-left so the round timer stays fully readable:

```
┌────────────────────────────────────────────────────────────────┐
│  ┌──────┐               13 │ 1:47 │ 8                          │
│  │ map  │              ────┴──────┴────                        │
│  └──────┘                                                      │
│  ╭────────────────────╮                                        │
│  │  ◍   ▃ ▅ ▃ ▂ ▁     │                                        │
│  ╰────────────────────╯       ✛                                │
│                                                                │
│                                                                │
│                                                                │
│  ♥ 100  ⛊ 50                                          30 │ 90  │
└────────────────────────────────────────────────────────────────┘
```

### 5.4 Optional caption mode (off by default)

For deaf/HoH users, noisy rooms, and anyone who wants a transcript. Expands the chip
downward; never covers screen centre.

```
    ╭────────────────────────────────────────────────╮
    │  ◉   ▅ ▂ ▆ ▃ ▁                                 │
    ├────────────────────────────────────────────────┤
    │  You: what's the recipe for a fire resistance  │
    │       potion                                   │
    │  Riki: awkward potion plus magma cream. You    │
    │        already have both in the left chest.    │
    ╰────────────────────────────────────────────────╯
```

---

## 6. Triggering

### 6.1 Decision: push-to-talk by default

Ranked against the alternatives:

| Mode | Verdict | Reasoning |
|---|---|---|
| **Push-to-talk** | **Default** | Matches existing game-voice muscle memory. Mic is closed except while held — the privacy story is trivial to explain. Zero false triggers from teammates or game audio. |
| **Tap-to-latch** | **Default, same key** | Hold for a short utterance, tap for a long one. Removes the "hold a key for 40 seconds" ergonomics problem without a second binding. |
| Wake word | Opt-in, off | Attractive but fragile in the target environment: teammate voice chat and game dialogue produce constant false wakes. Requires an on-device wake engine so no audio leaves the machine pre-wake. |
| Always listening | Not supported | Continuous open mic while a player is in voice chat with strangers is a privacy problem we should not ship, and it makes Riki's behaviour unpredictable mid-match. |

### 6.2 The tap/hold gesture

One key, two behaviours, disambiguated by a 250 ms threshold:

```
  key down ──┬── released < 250 ms  ──► LATCH: capture until key tapped again,
             │                            or 8 s of silence, or Esc
             │
             └── held ≥ 250 ms      ──► PUSH: capture until release
```

The threshold is tuned so a deliberate tap always latches and a natural "hold and speak" never
latches by accident. Latched sessions show a subtly brighter chip border so the two modes are
never confused.

### 6.3 Default binding ⚑

Default: **`Ctrl` + `` ` ``** (backtick/grave).

Games overwhelmingly bind bare keys and rarely bind `Ctrl` chords; backtick is usually a console
key, and the `Ctrl` modifier avoids that. There is no genuinely safe default across all games,
so the mitigation matters more than the choice:

- **Conflict detection at bind time.** When the user sets a hotkey, warn if it is a common game
  binding, and offer mouse buttons 4/5, which are the safest real-world choices.
- **Per-game hotkey overrides**, stored with the per-game overlay profile.
- **First-run capture check.** During onboarding, ask the user to launch a game and press the
  key; confirm we actually received it. Silent hotkey failure in full-screen exclusive mode is
  otherwise indistinguishable from the app being broken.

### 6.4 Global hotkey capture ⚑

This is the highest-risk implementation area and it differs sharply by platform.

**Push-to-talk needs both key edges**, which rules out the obvious cross-platform answer before
the platform split even starts: Electron's `globalShortcut` fires on key-*down* only, so it can
open the mic and never close it. Every platform below therefore needs a lower-level path than
the one Electron hands us. Per A3, macOS is the one that has to work.

- **macOS (primary):** a `CGEventTap` on `keyDown`/`keyUp`/`flagsChanged`, or
  `NSEvent.addGlobalMonitorForEvents`. Both are gated on the user granting **Accessibility**
  (Input Monitoring for the tap, depending on placement) in System Settings › Privacy & Security.
  This is the headline risk on the primary platform, and it fails in a specific, ugly way: the
  tap installs successfully and simply delivers no events, so a denied permission is
  indistinguishable from a broken app unless we check for it. Call
  `AXIsProcessTrustedWithOptions` at startup, make the grant an explicit onboarding step, and
  re-check on resume — the permission is revocable at any time and is dropped when the app
  bundle's signature changes, which includes every unsigned dev build. **This needs a spike
  before the UI is built on top of it.**
- **Linux / X11 (dev platform):** `XGrabKey`, or evdev with the user in the `input` group.
- **Linux / Wayland (dev platform):** no global hotkey API by design. Requires the
  `xdg-desktop-portal` `GlobalShortcuts` interface, which is not available on every compositor.
  Where it is missing, fall back to a tray-click or a bound mouse button, and say so plainly in
  onboarding rather than shipping a key that silently does nothing.
- **Windows (later):** low-level keyboard hook (`WH_KEYBOARD_LL`) or Raw Input. Works with
  borderless-windowed reliably; exclusive full-screen needs verification per title. No
  permission gate, but the global hook is the shape anti-cheat systems flag — see §13.3.

### 6.5 Overlay rendering ⚑

Same platform split, and the same preference order everywhere: a click-through, non-activating
desktop window, which costs nothing and needs no hook.

- **macOS (primary):** a transparent, frameless `NSWindow` with `ignoresMouseEvents`, raised to
  the `screen-saver` level. The macOS-specific trap is Spaces: a game in *native* full-screen
  gets its own Space, and an always-on-top window will not be composited over it unless the
  window opts in. In Electron terms that is
  `setAlwaysOnTop(true, 'screen-saver')` **plus**
  `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` — the second call is the one
  that is easy to omit and produces a chip that works perfectly in windowed mode and is invisible
  in the only mode that matters. Assert it in the overlay e2e.
- **Windows (later):** a layered window
  (`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`), which works for borderless-windowed.

Graphics-API hooking (Metal layer / Vulkan layer / DXGI present hook) only if exclusive
full-screen support proves necessary — it is substantially more invasive and carries the
anti-cheat risk that §13.3 wants kept off the table. Recommend shipping v1 as
desktop-window-only and documenting "use borderless windowed mode", which is also what the
capture layer requires (`dota2-state-capture-design.md` §2.2).

---

## 7. Non-visual feedback

### 7.1 Earcons

Two sounds, both ~80 ms, soft sine with a short attack — a timbre uncommon in game audio so
they do not blend into the mix:

| Event | Sound |
|---|---|
| Capture start | rising two-tone blip, 660 → 880 Hz |
| Capture end | falling two-tone blip, 880 → 660 Hz |
| Error | single low tone, 330 Hz, 140 ms |

Default −18 dBFS, independently adjustable, mutable. There is deliberately **no** earcon for
Processing or Speaking — TTS starting is its own audio cue, and a "thinking" sound would be
intolerable at the tenth repetition.

The capture-end earcon matters more than it looks: it is the only confirmation that the mic
actually closed, which is the thing users are anxious about.

### 7.2 Game audio ducking

While Riki speaks, duck other application audio by **−12 dB** with a 120 ms ramp in and a
250 ms ramp out. Without ducking, TTS is unintelligible over combat audio and the player will
just stop using the feature. Ducking is per-application where the OS allows it, and it must be
disableable — competitive players need to hear footsteps more than they need to hear Riki.

### 7.3 Haptics

**Not enabled by default.** Controller rumble is heavily used by games; a Riki pulse during
combat is indistinguishable from game feedback and actively confusing. Offered as opt-in for
capture start/end only: 40 ms, low-frequency motor, ~20 % amplitude. Never during Processing.

---

## 8. Timing and perceptual budget ⚑

These are UX requirements, not implementation targets — the visible chip must hit them
regardless of how slow the pipeline behind it is.

| Moment | Budget | Why |
|---|---|---|
| Key-down → chip visible | **≤ 100 ms** | Beyond this the trigger feels broken and users double-press |
| Key-down → bars respond to voice | ≤ 250 ms | Confirms the mic is genuinely live |
| Chip fade-in | 80 ms | Fast enough to feel instant |
| Chip fade-out | 200 ms, after a 400 ms hold | The hold prevents strobing on rapid interactions |
| Release → Speaking begins | ≤ 1.5 s target | Above this, conversation rhythm breaks down |
| Processing → show elapsed time | at 2.5 s | Turns "hung" into "working" |
| Processing → show cancel | at 10 s | Escape hatch before the user kills the app |
| Error → auto-dismiss | 4 s | Except permission errors, which persist until resolved |

The **≤ 100 ms** budget implies the overlay window is pre-created and hidden, not constructed
on demand. It also means chip appearance must not wait on the audio device opening.

---

## 9. Accessibility and edge cases

### 9.1 Accessibility

- **Reduced motion** (respects the OS setting): all looping animation is replaced by static
  opacity steps. Amplitude bars become a single static filled bar, since they carry real
  information; the sweeping Processing animation is replaced by a static glyph.
- **Colour vision:** covered by §4.3 — motion signature and glyph are independently sufficient.
- **Deaf / hard of hearing:** caption mode (§5.4), plus a visual-only alternative to every
  earcon.
- **Low vision:** overlay scale up to 1.5×; high-contrast variant raising `chip.bg` to 0.92
  opacity and `chip.border` to 0.4.
- **Motor:** tap-to-latch (§6.2) exists specifically so no interaction requires sustained key
  holding. All hotkeys rebindable, including to single mouse buttons.
- **Speech differences:** the 8 s listening timeout and the 1.2 s silence nudge must both be
  configurable — they are hostile defaults for users who speak slowly or with pauses.

### 9.2 Multi-monitor

Overlay anchors to the display containing the focused full-screen application, and follows
focus. On the desktop with no full-screen app, it anchors to the primary display. This is a
per-display setting, not a global one.

### 9.3 Streamers ⚑

Given A5, three requirements that are cheap now and expensive to retrofit:

1. **Overlay excludable from capture.** Set the window-affinity display-only flag so OBS and
   similar do not record the chip. On by default — viewers do not need to see it, and captions
   would leak private content to a live audience.
2. **Earcons on a separate audio stream** so they can be excluded from the stream mix.
3. **Caption mode never auto-enables.** A transcript overlay on a live stream is a privacy
   incident waiting to happen.

---

## 10. Rendering constraints

The overlay shares a GPU with a game that is trying to hold a frame budget. Non-negotiables:

- **Idle costs literally nothing.** No window, no timer, no compositing when Hidden.
- **Animate at 30 fps, not the game's refresh rate.** The bars carry no information that
  needs 144 Hz.
- **Composite-only animation.** Opacity and transform. No per-frame layout, no per-frame
  text shaping.
- **Stop the animation timer when the state is static** (Muted, settled Error).
- **Backdrop blur is off by default.** It is the single most expensive effect here and it is a
  polish item, not a legibility requirement — the hairline border already solves legibility.
- **Target: < 0.3 ms GPU per frame while visible, 0 while hidden.**

---

## 11. Settings surface

Keep it small. Everything below is genuinely load-bearing for some user; anything not listed
should have to argue its way in.

```
  Trigger      hotkey binding · tap-to-latch on/off · hold threshold
               wake word (off) · per-game hotkey overrides
  Overlay      anchor (8 presets + drag) · scale · per-game profiles
               caption mode (off) · high contrast · reduced motion (auto from OS)
  Audio        input device + live level meter · earcon volume
               game ducking on/off + depth · haptics (off)
  Timing       silence nudge delay · listening timeout
  Privacy      exclude overlay from screen capture (on)
               mic activity log · clear history
```

---

## 12. Rejected alternatives

Recorded so they do not get re-proposed:

| Rejected | Why |
|---|---|
| Animated avatar / face | Directly contradicts "invisible until needed"; steals attention continuously; ages badly |
| Always-visible idle dot | Same. Muted is the one justified exception, because absence would be ambiguous |
| Tray-only, no overlay | No feedback in full-screen, no mic-level confirmation — the primary failure mode goes unaddressed |
| Screen-edge glow / border pulse | Reads as a damage or low-health indicator in almost every game |
| Full transcript always on screen | Foveal attention cost per §1.5; privacy hazard for streamers |
| Red for errors | Misread as game damage feedback (§4.2) |
| Centre-screen modal for confirmations | Covers the crosshair; unacceptable mid-match. Moot since ADR-0023 — nothing needs confirming |
| Voice-only, no visual at all | Fails silently when the mic is dead — the one case feedback matters most |

---

## 13. Open questions

1. **Does Riki need an input path beyond voice?** Confirming (§3) currently assumes `Y`/`N`
   keys. If the agent takes consequential actions, a voice-only confirmation may not be
   sufficiently deliberate.
2. **Exclusive full-screen: required for v1?** Drives the §6.5 layered-window vs. API-hooking
   decision, and with it the anti-cheat risk profile. Recommend deferring the hook.
3. **Anti-cheat clearance.** A global key tap plus an always-on-top overlay needs testing against
   VAC on the primary platform before this design is built on. **Blocking risk — spike first**;
   see [the runbook](../runbooks/anticheat-validation.md).
4. **macOS permission grants (§6.4, §6.5).** Push-to-talk needs Accessibility and capture needs
   Screen Recording, both revocable and both silent when denied. The open question is not whether
   we can request them but what Riki does when a user says no — degrade to tray-click and
   GSI-only, or refuse to start? Needed before onboarding is designed. Wayland's
   `GlobalShortcuts` portal gap is the same shape of problem but now only on the dev platform,
   so it costs developer ergonomics rather than users.
5. **Multi-turn conversation.** This design covers single request → response. Sustained
   back-and-forth may need a persistent "session active" affordance that the current state
   model does not have.
6. **Does Riki have anything to say unprompted?** Every state here is user-initiated. Proactive
   notifications would be a significant departure from principle 1 and should be designed
   separately, if at all.

**1, 5 and 6 have since been answered** — see
[overlay-architecture.md](overlay-architecture.md) §14, which records where and why, and
[ADR-0023](../adr/0023-coaching-replaces-command-execution.md), which answered 1 a second time by
removing the question. In short:

- **1 is moot.** It was answered with a narrow keyboard path scoped to Confirming, because a
  click-through window can take no pointer input at all. ADR-0023 then deleted the only
  consequential action Riki had, so there is nothing left to confirm and no keyboard path to
  scope. Riki is voice-and-hotkey only.
- **5** needs no new state, since Speaking → trigger → Listening is already one edge.
- **6 is *yes*, and it is now the primary path rather than an addition.** `dota2` §6.4 and
  [coaching-architecture.md](coaching-architecture.md) have Riki speaking unprompted when the
  trigger policy fires — a Hidden → Speaking transition this document originally did not have and
  §3.1 now draws. What makes that safe is not a state: it is the gates (coaching §6.3) and the
  local `quiet-mode` phrase, which must work with the model down.

2, 3 and 4 are still open, and **3 is still blocking**.

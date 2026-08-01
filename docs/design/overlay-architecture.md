# Riki — Overlay Component Architecture

**Status:** Implemented, except where noted below. Steps 1–4 of §15's build order have landed:
the machine, the runtime, the window controller and the renderer. Step 5 (adapters) waits on the
packages it adapts; step 6 (moving the wire types to `@riki/protocol`) is a coordination event.
**Not landed:** the Tier 5 Playwright harness and the `apps/desktop` shell that would launch a
window — the app entry, the bundler, and `pnpm build` / `pnpm dev`. Until those exist, the
component is exercised by 246 unit tests and has never been rendered on a screen. Every number in
§12 remains unverified.
**Scope:** The technical architecture of the voice agent's visible surface — the overlay chip,
the machine that drives it, and the seams between it and the rest of Riki.
**Reads with:** [`ui-design.md`](ui-design.md) is the *product* specification for this surface —
states, colours, motion, timing budgets. This document does not restate it; it says how the code
is arranged so that specification can be met and kept.
**Out of scope:** The tray menu's contents (ui-design §2.3), hotkey capture per platform
(ui-design §6.4), the Realtime session itself
([`openai-realtime-research.md`](../research/openai-realtime-research.md)).

---

## 0. Assumptions

Written against a skeleton repo, so the load-bearing assumptions are stated up front. Sections
marked ⚑ are what changes if one is wrong.

| # | Assumption | Source | Affects |
|---|---|---|---|
| B1 | The anti-cheat spike passes: a global hook plus an always-on-top click-through window is viable | ui-design §13.3, REPO_SKELETON §11.6 | ⚑ everything below. **This is still unrun** — `docs/runbooks/anticheat-validation.md` |
| B2 | Electron survives the frame-time harness and stays the shell | ADR-0001, REPO_SKELETON §11.1 | ⚑ §3, §6 (process shape) |
| B3 | Riki speaks unprompted when the trigger policy fires | dota2 §6.4, `RIKI_UNPROMPTED` | ⚑ §4.3 (a chip that appears with no gesture) |
| B4 | Riki takes no action inside the game **and has no consequential act at all** — ADR-0023 deleted `read_screen`, the only one there was | ADR-0003, ADR-0023 | §4.4 (Acting and Confirming, and why they are gone) |
| B5 | The mic is owned by a Chromium renderer, because WebRTC and AEC are why the shell is Electron | ADR-0002, REPO_SKELETON A2 | ⚑ §3.2, ADR-0010 |

**B1 is the one that can invalidate this whole document.** Nothing here should be built before
the spike lands. The design is written now because the spike's outcome does not change *what the
modules are* — only whether they can exist at all.

---

## 1. What this component is

The overlay is the answer to *"what is Riki doing right now?"*, rendered where the player is
already looking (ui-design §2). Concretely it is four things, and keeping them separate is most
of the architecture:

1. **An interaction machine** — the authority on what state the interaction is in. Pure,
   synchronous, no I/O, no Electron.
2. **A window** — a click-through, always-on-top, per-pixel-alpha `BrowserWindow` that exists
   from app start and is *shown*, not created, on demand.
3. **A view** — renderer code that draws a chip from a view model and a level stream, and knows
   nothing else about Riki.
4. **A set of adapters** — the code that turns Realtime events, audio faults, trigger gestures
   and policy decisions into machine inputs, and machine effects back into calls on those
   subsystems.

### 1.1 Non-goals

- **The overlay is not a control surface.** The window is click-through
  (`setIgnoreMouseEvents(true)`), so it cannot receive a mouse event at all. Everything the chip
  shows is a *hint* — `Esc ✕`, `Fix ▸`, `[Y] yes` — never a button. This is easy to get wrong
  because ui-design §5.1's wireframes look like buttons; they are keyboard affordances rendered
  as text. The tray and the settings window are the control surfaces.
- **The overlay does not decide whether Riki should speak.** `packages/events` does (dota2 §6.4).
  The overlay decides whether a *pixel* appears.
- **The overlay holds no conversation state.** No transcript, no history, no session identity.
  Caption text arrives as an already-redacted view model field and is dropped on exit.

---

## 2. The decomposition at a glance

```
                    ┌───────────────────────────── Electron main ─────────────────────────────┐
                    │                                                                         │
  hotkey / OS ──────┼─► trigger/          ─┐                                                  │
                    │   GestureRecognizer  │                                                  │
  @riki/realtime ───┼─► adapters/          ├─► session/            ─┬─► overlay/              │
  @riki/audio ──────┼─►   VoiceBridge      │     InteractionMachine │     OverlayPresenter    │
  @riki/events ─────┼─►   PolicyBridge     │     (pure reduce)      │     WindowController    │
  @riki/config ─────┼─►   SettingsBridge  ─┘     SessionRuntime     │     PlacementResolver   │
                    │                            (effects, timers)  │     LevelPump           │
                    │                                               ├─► tray/    TrayPresenter│
                    │                                               └─► audio/   earcons,     │
                    │                                                           ducking       │
                    └───────────────────────────────┬─────────────────────────────────────────┘
                                                    │ preload bridge — the only path
                                    ChipViewModel ──┤ LevelFrame ──►      ◄── OverlayIntent
                                                    │
                    ┌───────────────────────────────┴───── overlay renderer ──────────────────┐
                    │   OverlayApp ─► ChipView ─► GlyphView · BarsView · TextSlot · Caption   │
                    │       │            ▲                                                    │
                    │   AnimationClock ──┘   MotionDirector (pure) · LevelBallistics (pure)    │
                    │                        tokens/ (the only place a colour value exists)    │
                    └─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Directory layout

Everything below lives in `apps/desktop`, which REPO_SKELETON §2.2 gives as the owner of the
chip, the tray and the hotkey.

```
apps/desktop/src/
├── main/
│   ├── session/          InteractionMachine (pure) + SessionRuntime + timers
│   ├── overlay/          window lifecycle, placement, level pump, chip projection
│   ├── trigger/          hotkey binding, gesture recognition            (sibling task)
│   ├── tray/             tray projection                                (sibling task)
│   └── adapters/         @riki/* ↔ machine translation
├── preload/
│   └── overlay-bridge.ts the only path in or out of the overlay renderer
├── renderer/overlay/
│   ├── app.ts            composition root
│   ├── view/             ChipView, BarsView, GlyphView, TextSlot, CaptionPanel
│   ├── motion/           MotionDirector, AnimationClock
│   ├── level/            LevelBallistics
│   └── tokens/           token names (TS) + values (CSS)
└── shared/
    └── overlay.ts        the vocabulary both sides speak (§6.3)
```

### 2.2 Why this split and not the obvious one

The obvious arrangement puts the state machine in the renderer, next to the thing it draws. Three
constraints rule it out, and they are the reason for ADR-0009:

- **≤100 ms key-down → chip visible** (ui-design §8). Only main receives the hotkey and only main
  can show a window. If the renderer owned the state, the show decision would need a round trip
  before the window could be mapped, and the budget would be spent on scheduling.
- **The tray and the earcons are the same state.** ui-design §2.3 gives the tray four states and
  §7.1 makes earcons "part of the state model, not decoration" (also the `voice-realtime` skill).
  Three surfaces derived from one machine cannot disagree; three surfaces with their own state
  eventually will.
- **A renderer crash must not lose the interaction.** With the machine in main, recovery is
  reloading the window and re-projecting. With it in the renderer, a crash mid-turn leaves the
  mic open and nothing on screen.

The cost is a projection step and a wire format, both of which §6 pins down.

---

## 3. Process and window topology

### 3.1 Three windows, two of which are never seen

| Window | Shown | Owns | Lifetime |
|---|---|---|---|
| **Overlay** | On demand, ≤100 ms | The chip. No Node, no mic, no network. | Created at app start, hidden; destroyed at quit |
| **Voice** | Never | `getUserMedia`, the WebRTC peer connection, AEC (ADR-0010) | Created when a match starts; survives the overlay |
| **Settings / onboarding** | On user request | Ordinary app window, ordinary input | On demand |

### 3.2 Why the mic is not in the overlay window — ADR-0010

B5 puts the mic in a renderer. Putting it in the *overlay* renderer would couple a live audio
session to a window that is shown, hidden, moved between displays and re-placed on every HUD
scale change, and would mean a crash in the chip's drawing code kills the conversation. It also
breaks "idle costs literally nothing": the overlay renderer should be free to stop every timer
when hidden, and the voice session must not be.

So: a permanently hidden voice window owns the audio graph; the overlay window is view-only. The
cost is one extra renderer process and one extra hop for level frames (voice → main → overlay,
single-digit milliseconds at 30 Hz — irrelevant against the 250 ms "bars respond to voice"
budget). Recorded as ADR-0010, marked Proposed rather than Accepted because it constrains
`packages/realtime`'s host as much as it constrains the overlay.

### 3.3 The overlay window itself

```ts
new BrowserWindow({
  frame: false, transparent: true, resizable: false, movable: false,
  focusable: false, skipTaskbar: true, show: false,
  webPreferences: {
    contextIsolation: true,          // §6.2 — non-negotiable
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,     // see below — this one is load-bearing
    preload: overlayPreloadPath,
  },
});
win.setAlwaysOnTop(true, 'screen-saver');
win.setIgnoreMouseEvents(true);
win.setContentProtection(true);      // ui-design §9.3, on by default
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
```

Four properties of this configuration carry design decisions rather than taste:

- **`show: false` at creation, never `destroy()` between sessions.** "Hidden renders no window"
  (ui-design §10) means *no visible, composited window* — an unmapped window has no surface and
  no frames. It does not mean constructing a `BrowserWindow` on each key press, which cannot
  meet the 100 ms budget. The e2e assertion is on `isVisible() === false` plus a frame counter
  that does not advance (§10.4).
- **`backgroundThrottling: false`.** Chromium throttles timers and rAF in windows that are not
  visible. A warm-but-throttled renderer would take up to a second to produce its first frame
  after `show()`, which spends the entire budget on something invisible in a profile.
- **`focusable: false` + `setIgnoreMouseEvents(true)`.** The overlay must never steal focus from
  the game; combined they also mean the chip can carry no clickable affordance (§1.1).
- **`setContentProtection(true)` is not portable.** On macOS — the primary target, per ui-design
  A3 — it maps to `NSWindowSharingType.none`, so the feature does work where it matters most; on
  Windows it maps to window-affinity; on Linux/X11 there is no equivalent, which means the dev
  platform is the one where this cannot be exercised. The setting must report what it actually
  achieved rather than claiming an exclusion it did not get — a streamer discovering the chip in
  their VOD is exactly the failure ui-design §9.3 is trying to avoid.

### 3.4 One window size, not one per state

The chip's width is content-driven, 32→180 px (ui-design §4.1), and caption mode expands it
downward. The window does **not** track that. It is sized once per (anchor, scale, display) to a
fixed logical box large enough for the widest chip plus a caption panel, and everything animates
*inside* it. Resizing or moving a transparent always-on-top window per state change is visibly
janky, costs a compositor round trip, and would put layout on the animation path — which §10 of
ui-design forbids. The window only changes bounds when the anchor, the scale, or the target
display changes.

---

## 4. The interaction machine

### 4.1 Shape

A pure reducer plus two projections. No clock reads, no I/O, no randomness — `now` is an
argument, and everything time-driven is expressed as a scheduled timer input.

```ts
// apps/desktop/src/main/session/machine.ts

export function initial(env: MachineEnvironment): MachineState;

export function reduce(
  state: Readonly<MachineState>,
  input: MachineInput,
  now: Millis,
): Transition;                                   // { state, effects }

export function projectChip(state: Readonly<MachineState>, now: Millis): ChipViewModel;
export function projectTray(state: Readonly<MachineState>): TrayGlyph;
```

`Transition.effects` is an ordered list. Order matters exactly once: a `window` effect that makes
the overlay visible is applied before anything else in the list, because it is the only one on
the 100 ms path.

### 4.2 State

The nine states of ui-design §3 are not nine equal cases. **Muted is a condition, not a phase** —
it changes what a trigger does and what Hidden looks like, but you cannot be "muted and
listening". Modelling it as a flag removes eighteen impossible combinations from the reducer.

```ts
export type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'armed';      readonly gesture: CaptureMode }
  | { readonly kind: 'listening';  readonly gesture: CaptureMode; readonly silentSince: Millis | null }
  | { readonly kind: 'processing'; readonly startedAt: Millis }
  | { readonly kind: 'speaking';   readonly unprompted: boolean }
  | { readonly kind: 'error';      readonly fault: Fault };

export interface MachineState {
  readonly phase: Phase;
  readonly since: Millis;                     // when `phase` was entered
  readonly muted: boolean;
  readonly latched: boolean;                  // tap-to-latch, ui-design §6.2
  readonly pending: readonly PendingTimer[];  // scheduled, so they can be cancelled on exit
  readonly reported: readonly FaultKind[];    // "fail loudly, but only once" — §1.6
  readonly env: MachineEnvironment;           // settings snapshot, injected from @riki/config
  readonly revision: number;                  // monotonic; the renderer drops stale models
}
```

`reported` is the whole of principle 1.6. A mic that is denied does not re-announce itself every
turn; the fault kind is recorded on first report and subsequent identical faults transition
silently. It resets when the condition clears or the session ends.

### 4.3 Inputs

```ts
export type MachineInput =
  | { readonly kind: 'trigger';   readonly event: TriggerEvent }        // trigger/
  | { readonly kind: 'capture';   readonly event: 'opened' | 'firstAudio' | 'closed' }
  | { readonly kind: 'speech';    readonly event: 'silence' | 'resumed' }
  | { readonly kind: 'turn';      readonly event: 'submitted' | 'responseStarted' | 'responseEnded' }
  | { readonly kind: 'unprompted'; readonly event: 'speechStarted' }    // B3, and now the main path
  | { readonly kind: 'fault';     readonly fault: Fault }
  | { readonly kind: 'mute';      readonly muted: boolean }
  | { readonly kind: 'settings';  readonly env: MachineEnvironment }
  | { readonly kind: 'timer';     readonly id: TimerId }
  | { readonly kind: 'intent';    readonly intent: OverlayIntent };     // from the renderer

export type TriggerEvent =
  | { readonly kind: 'down' } | { readonly kind: 'up' }
  | { readonly kind: 'tap' }  | { readonly kind: 'cancel' };            // Esc
```

**`unprompted.speechStarted` is the input ui-design does not have.** Its §13.6 asks whether Riki
ever speaks unasked; dota2 §6.4 answers yes and `RIKI_UNPROMPTED` is already in `.env.example`.
That path enters Speaking straight from Idle with no Armed and no gesture, which means: the chip
must fade in on a state the user did not cause, and barge-in has to work from it (holding the
trigger during unprompted speech cancels it and starts listening — the same edge, no special
case). Recorded in §14 as resolving that open question.

### 4.4 Acting and Confirming: deleted, and why they were here

**This section used to argue that Acting and Confirming were not dead states in a read-only
product.** The argument was sound and its premise is gone:

| State | What it meant here | Its only producer |
|---|---|---|
| **Acting** | A tool call slow enough to need its own pixels | `read_screen` (a VLM round trip), `get_matchup_advice` on a cold cache |
| **Confirming** | The consent gate in front of `read_screen` | dota2 §7's requirement that a frame leaving the machine be unmistakable |

[ADR-0023](../adr/0023-coaching-replaces-command-execution.md) deleted command execution. Nothing
in the coaching path is slow enough to need pixels — brief assembly is pure, in-process and inside
the snapshot's <5 ms budget — and nothing sends anything off the machine that is not audio, so
nothing needs permission. Both states, both their glyphs, the amber `confirm` accent, the
`confirm` affordance, the `confirm-timeout` timer, the `keys` effect and the scoped `Y`/`N`/`Esc`
accelerators are removed. `ActingVerb` and `ConfirmPrompt` go with them.

**Two consequences worth stating rather than leaving implicit.**

B4 becomes structurally true rather than true by policy: with `read_screen` gone, Riki has no
consequential act at all and the product has no permission prompt anywhere. That is a stronger
position than the one this section used to defend.

And the scoped-accelerator problem disappears with the state that had it. A click-through window
takes no pointer input, which is why Confirming needed a keyboard grab in the first place, and a
permanently grabbed `Y` would eat a chat-wheel key mid-match. There is now no state in this design
that needs the keyboard for anything but the push-to-talk binding.

**What replaces them: nothing.** A coaching turn is Speaking with `unprompted: true` (§9.3) — no
Armed, no earcon, an 80 ms fade-in, and barge-in from it costs exactly one key press. That path
already existed and is now the most common thing the chip does.

### 4.5 Effects

The reducer never calls anything. It returns descriptions:

```ts
export type Effect =
  | { readonly kind: 'window';   readonly visible: boolean; readonly holdMs?: Millis }
  | { readonly kind: 'project' }                                        // send the chip model
  | { readonly kind: 'schedule'; readonly id: TimerId; readonly delayMs: Millis }
  | { readonly kind: 'cancel';   readonly id: TimerId }
  | { readonly kind: 'levels';   readonly running: boolean; readonly source: LevelSource }
  | { readonly kind: 'earcon';   readonly sound: EarconId }
  | { readonly kind: 'duck';     readonly on: boolean }
  | { readonly kind: 'voice';    readonly command: VoiceCommand };      // interrupt | abort

export type VoiceCommand =
  | { readonly kind: 'interrupt'; readonly at: Millis }                 // barge-in → truncate
  | { readonly kind: 'abort' };                                         // Esc
```

Two things fall out of this that are worth the indirection:

- **The reducer is testable as a table.** Tier 1 can assert the full state × input matrix,
  including that a `window: false` effect always carries the 400 ms hold from ui-design §8 and
  that leaving Listening always emits the capture-end earcon — the one confirmation that the mic
  actually closed (§7.1).
- **`levels: { running: false }` is how "idle costs nothing" is enforced upstream.** The level
  pump does not run when the chip cannot show bars, so a hidden overlay costs no IPC at all,
  not merely no pixels.

### 4.6 Timers

Every timing rule in ui-design §8 is a scheduled input, so none of them is a `setTimeout`
scattered through view code:

| Timer | Fires | Effect |
|---|---|---|
| `silence-nudge` | 1.2 s of silence while Listening | bars flatten, chip dims to 60 % |
| `listen-timeout` | 8 s of capture with no speech | → Error, "didn't catch that" |
| `elapsed-hint` | 2.5 s in Processing | chip grows an elapsed counter |
| `cancel-hint` | 10 s in Processing | chip surfaces `Esc ✕` |
| `error-dismiss` | 4 s in Error | → Idle, unless the fault is persistent |
| `hide-hold` | 400 ms after entering Idle | window hidden after the renderer's 200 ms fade |

`hide-hold` is the one timer the machine does **not** schedule. The hold travels on the `window`
effect (§4.5) and `OverlayWindowController` owns it, because the thing that has to cancel it is a
`showFast()` arriving mid-hold — and only the controller sees that. It stays in `TimerId` because
the controller schedules it on the same injected `Clock`.

The nudge and the timeout are user-configurable (ui-design §9.1: they are hostile defaults for
people who speak slowly), which is why they come from `MachineEnvironment` rather than being
constants in the reducer.

---

## 5. Main-process classes

Signatures are the contract; the bodies are step 6 work. Every one of these takes its
collaborators by injection, because that is what lets the runtime be tested with a fake clock and
a fake window in Vitest, with no Electron at all.

### 5.1 `SessionRuntime` — the only stateful thing in the design

```ts
export interface SessionRuntime {
  dispatch(input: MachineInput): void;      // synchronous; applies effects before returning
  snapshot(): Readonly<MachineState>;       // for tests, telemetry and window recovery
  subscribe(fn: (s: Readonly<MachineState>) => void): Unsubscribe;
  dispose(): void;
}

export interface SessionRuntimeDeps {
  readonly machine: MachineModule;          // pure; swapped in tests
  readonly clock: Clock;                    // monotonic now() + timer scheduling
  readonly overlay: OverlayPresenter;
  readonly tray: TrayPresenter;
  readonly voice: VoiceCommandSink;
  readonly audio: AudioEffectSink;          // earcons, ducking
  readonly telemetry: TelemetrySink;
}

export function createSessionRuntime(deps: SessionRuntimeDeps, env: MachineEnvironment): SessionRuntime;
```

`dispatch` being synchronous is not an implementation detail — it is what keeps the show call in
the same tick as the key press. No `await` may appear between receiving a trigger and calling
`showFast()`.

### 5.2 `OverlayPresenter` — machine state to renderer

```ts
export interface OverlayPresenter {
  setVisible(visible: boolean, holdMs?: Millis): void;
  project(model: ChipViewModel): void;
  setEnvironment(env: OverlayEnvironment): void;
  pushLevel(frame: LevelFrame): void;
  onIntent(fn: (intent: OverlayIntent) => void): Unsubscribe;
  onRendererReady(fn: () => void): Unsubscribe;    // re-project after a reload
  dispose(): void;
}
```

The presenter is the *only* thing in main that knows a renderer exists. It also owns the
staleness rule: models carry `revision`, and the presenter drops a level frame that arrives for a
revision the renderer has already superseded.

### 5.3 `OverlayWindowController` — the Electron surface

```ts
export interface OverlayWindowController {
  warm(): Promise<void>;              // create, load, paint once, hide. Called at app start.
  showFast(): void;                   // synchronous showInactive(). No awaits, no allocation.
  hide(afterMs?: Millis): void;
  isVisible(): boolean;
  send(command: OverlayCommand): void;
  sendLevel(frame: LevelFrame): void;   // separate channel — §6.1
  applyPlacement(bounds: Rectangle, scale: number): void;
  setCaptureExcluded(on: boolean): CaptureExclusionResult;   // reports what it actually got
  reload(): Promise<void>;            // crash recovery
  destroy(): void;
}
```

`warm()` is the 100 ms budget. It creates the window, loads the renderer, waits for the first
paint, then hides — so that `showFast()` is a compositor map of a surface that already exists.
The paint-once step is the part most likely to be skipped and the part that matters most; §12
lists it as a claim to verify on real hardware rather than assume from documentation.

### 5.4 `PlacementResolver` — pure geometry

```ts
export interface DisplaySnapshot {
  readonly id: number;
  readonly workArea: Rectangle;
  readonly scaleFactor: number;
}

export interface PlacementResolver {
  resolve(anchor: AnchorPreset | DragPlacement, display: DisplaySnapshot, chipScale: ChipScale): Rectangle;
  targetDisplay(displays: readonly DisplaySnapshot[], hint: DisplayTargetHint): DisplaySnapshot;
}

export type DisplayTargetHint =
  | { readonly kind: 'gameWindow'; readonly bounds: Rectangle }   // from the capture sidecar
  | { readonly kind: 'focused';    readonly bounds: Rectangle }   // "focused" is a window property
  | { readonly kind: 'primary' };
```

Pure arithmetic over injected display data, so the eight anchor presets, the 12 px inset, the
four scale steps and the multi-monitor rule in ui-design §9.2 are all Tier 1 unit tests with no
window. The `gameWindow` hint is the interesting one: the capture sidecar already knows the Dota
window's bounds because capture is window-scoped (dota2 §7), so the overlay can follow the game
across displays rather than guessing from focus. It degrades to `focused` and then `primary`, and
never blocks on the sidecar — a hint that has not arrived is not an error.

### 5.5 `LevelPump` — 30 Hz, and only while it can be seen

```ts
export interface LevelPump {
  start(source: LevelSource): void;    // 'input' | 'output'
  stop(): void;
  isRunning(): boolean;
  onFrame(frame: LevelFrame): void;    // called by the voice window's forwarder
}
```

Driven by the `levels` effect, never by the view. Coalesces to one frame per ~33 ms and drops
frames while the overlay is hidden. ui-design §10 asks for 30 fps rather than the game's refresh
rate; this is where that is enforced, upstream of the renderer, so a bug in the view cannot turn
into 144 IPC messages per second.

### 5.6 Adapters — where the rest of Riki is allowed to be mentioned

```ts
export interface VoiceBridge {                 // @riki/realtime + @riki/audio → inputs
  attach(session: RealtimeSessionHandle, sink: (input: MachineInput) => void): Unsubscribe;
  commands(): VoiceCommandSink;                // effects → session.interrupt / abort
}

export interface PolicyBridge {                // @riki/events → unprompted speech
  attach(policy: TriggerPolicyHandle, sink: (input: MachineInput) => void): Unsubscribe;
}

export interface SettingsBridge {              // @riki/config → MachineEnvironment
  current(): MachineEnvironment;
  watch(sink: (env: MachineEnvironment) => void): Unsubscribe;
}
```

This is the layer that keeps `session/` free of vendor vocabulary. The machine has never heard of
`response.audio.done` or `conversation.item.truncate`; it has heard of
`turn.responseEnded` and `voice.interrupt`. When the Realtime API's event names change — and
`openai-realtime-research.md` §3 documents that they already did once, silently — the diff is
confined to one file with a table in it.

### 5.7 `GestureRecognizer` — a seam, not a dependency

The hotkey layer is a sibling task (REPO_SKELETON §2.2 assigns it the same directory). The
overlay depends only on `TriggerEvent`, and on the recogniser being pure:

```ts
export interface GestureRecognizer {
  keyDown(now: Millis): readonly TriggerEvent[];
  keyUp(now: Millis): readonly TriggerEvent[];
  tick(now: Millis): readonly TriggerEvent[];    // the 250 ms hold threshold expiring
}
```

Pure and clock-injected for the same reason the machine is: the tap/hold threshold in ui-design
§6.2 is a number that needs a test, and testing it should not require a keyboard.

---

## 6. The bridge

### 6.1 Two channels, one direction each

| Channel | Direction | Payload | Rate |
|---|---|---|---|
| `riki:overlay:command` | main → renderer | `OverlayCommand` | on change (a few per turn) |
| `riki:overlay:level` | main → renderer | `LevelFrame` | ≤30 Hz, only while visible |
| `riki:overlay:intent` | renderer → main | `OverlayIntent` | rare |

```ts
export type OverlayCommand =
  | { readonly kind: 'model';  readonly model: ChipViewModel }
  | { readonly kind: 'env';    readonly env: OverlayEnvironment }
  | { readonly kind: 'teardown' };

export type OverlayIntent =
  | { readonly kind: 'ready' }                                  // renderer mounted; re-project
  | { readonly kind: 'cancel' }                                 // Esc reached the renderer first
  | { readonly kind: 'paint';   readonly revision: number }     // first paint of that model
  | { readonly kind: 'fault';   readonly message: string };     // the renderer's only log path
```

`paint` is how the ≤100 ms budget is measured rather than asserted: main stamps the trigger
arrival on its own monotonic clock, the renderer reports the revision it painted, and main
computes the delta. Both timestamps come from main's clock, so there is no cross-process clock
skew to reason about; the number is pessimistic by one IPC hop, which is the safe direction.

### 6.2 The preload surface

```ts
// apps/desktop/src/preload/overlay-bridge.ts
export interface RikiOverlayBridge {
  onCommand(fn: (command: OverlayCommand) => void): Unsubscribe;
  onLevel(fn: (frame: LevelFrame) => void): Unsubscribe;
  send(intent: OverlayIntent): void;
}
export function exposeOverlayBridge(): void;   // contextBridge.exposeInMainWorld('rikiOverlay', …)
```

Rules that hold here, all of them from REPO_SKELETON §6.2 and §7.1:

- `contextIsolation` stays on and no Node object is exposed. The bridge surface above is the
  entire API — three functions, no escape hatches, no `ipcRenderer`.
- **Inbound intents are validated and allow-listed** before they reach the machine. The renderer
  is the least privileged process in the app and is treated as untrusted input.
- **Nothing secret crosses.** The API key is resolved by `@riki/config` in main and injected into
  `@riki/realtime` (§7.1); there is no code path from it to this file, and §5.4's test asserts
  its absence from the bridge surface.
- **The renderer has no logger.** `no-console` is an error outside `packages/telemetry`, and the
  renderer may not import packages. It reports through `intent: 'fault'` and main logs it, which
  also means renderer diagnostics go through the same redaction rules as everything else.

### 6.3 Who owns these types

Per REPO_SKELETON §4, a message crossing a process boundary belongs in `packages/protocol` as a
zod schema. `packages/protocol` is step 2 and is still empty, so the shapes above are landing as
**types in `apps/desktop/src/shared/overlay.ts`** with an explicit note in the file: when step 2
lands, `OverlayCommand`, `OverlayIntent` and `LevelFrame` become zod schemas in `@riki/protocol`,
their inferred types replace the hand-written ones, and this file re-exports rather than defines.
Doing that swap is a protocol change and therefore a coordination event.

Keeping them in `shared/` in the meantime is deliberate: writing them into `packages/protocol`
now would mean landing a codegen and contract-test change for messages no code sends yet, and
`shared/` is the one place both main and the renderer can already read from without violating a
boundary.

---

## 7. Renderer classes

The renderer receives a view model and a level stream. It has no access to Riki's state, no
timers of its own beyond the animation clock, and no knowledge of what a "turn" is.

### 7.1 Composition root

```ts
export interface OverlayApp {
  update(model: ChipViewModel): void;
  level(frame: LevelFrame): void;
  environment(env: OverlayEnvironment): void;
  dispose(): void;
}

export function mountOverlay(root: HTMLElement, bridge: RikiOverlayBridge): OverlayApp;
```

### 7.2 Views

```ts
export interface ChipView {
  update(model: ChipViewModel): void;       // event-driven: layout is allowed here
  frame(sample: MotionSample): void;        // per-frame: transform and opacity only
  dispose(): void;
}

export interface BarsView  { setHeights(heights: readonly number[]): void; setVisible(v: boolean): void }
export interface GlyphView { set(glyph: GlyphId, accent: AccentToken): void }
export interface TextSlot  { set(text: ChipText | null): void; tickElapsed(seconds: number): void }
export interface CaptionPanel { set(captions: CaptionModel | null): void }
```

The `update` / `frame` split is the whole of ui-design §10's "composite-only animation". `update`
runs a handful of times per turn and may reflow — the chip's width animation (160 ms, ease-out)
happens here. `frame` runs at 30 Hz and may only write `transform` and `opacity`; the five level
bars are `scaleY` on pre-sized elements, never height changes, and the elapsed counter ticks once
a second through `tickElapsed` rather than being re-shaped every frame.

`ChipText.elapsedMs` is a **duration**, not the timestamp the turn started at. `Millis` is main's
monotonic clock and the renderer has no access to it, so a start time would be a number the
renderer could not subtract anything from; it is sent the elapsed value main measured and counts on
from there. The field was `elapsedFromMs` in the first draft of this document, which was wrong.

### 7.3 Motion and the animation clock

```ts
export interface AnimationClock {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  subscribe(fn: (tMs: Millis) => void): Unsubscribe;
  framesRendered(): number;                  // dev/e2e only — the idle assertion reads this
}

export interface MotionDirector {
  signatureFor(state: ChipState, prefs: MotionPreferences): MotionSignature;
  sample(signature: MotionSignature, tMs: Millis, level: number): MotionSample;  // pure
  isStatic(signature: MotionSignature): boolean;
}
```

`isStatic` is what stops the clock. Muted and a settled Error have no animation, and
ui-design §10 requires the timer to stop, not merely to render identical frames.

`isStatic` alone turned out not to be enough, and the gap is the word *settled*: an Error that has
finished its double-pulse is static, but the same signature ten milliseconds after entry is not.
The module therefore also exports `settlesAtMs(signature): Millis | null` — when a signature stops
moving, or `null` if it never does — and the composition root stops the clock at that time. Keeping
it a free function rather than a fourth method leaves `MotionDirector` a pure function of its
arguments with no notion of "when did this state start". Reduced motion
turns most signatures static, so on a machine with the OS setting on, the overlay's steady state
is genuinely zero work.

`sample` is pure and gets the exhaustive test that §5.4 asks for, with one correction that only
appeared when the assertion was written: motion signatures are **not** pairwise distinct, and
cannot be — Armed, Muted and a settled Error are all static. What is distinct is the *glyph*, and
what the test asserts is the pair — six visible states, six glyphs, six (glyph, motion) pairs.
That still delivers what §4.3 actually asks for, which is that no state is told apart by colour
alone. (Before ADR-0023 it was eight of each, and the pair mattered more: Acting duplicated
Processing's sweep. Deleting Acting removed the only *live* signature collision, so the assertion
is stronger now than when it was written.) Reduced motion is a variant of each state, not a global off switch —
the amplitude bars carry real information and become a single static filled bar rather than
disappearing.

### 7.4 Level ballistics

```ts
export interface LevelBallistics {
  push(rms: number, now: Millis): number;                 // smoothed 0..1, attack ≠ decay
  bars(level: number, count: number): readonly number[];  // pure, quantised bar heights
  reset(): void;
}
```

The boundary with `packages/audio` is worth stating because it looks arbitrary: **audio owns the
signal, the renderer owns the ballistics.** RMS and the TTS output envelope are audio maths and
belong in `packages/audio` where they are unit-tested against known PCM (§5.2's
`FakeAudioDevice`). Attack/decay smoothing and quantisation to five bars are *display* decisions
— they exist to make a 30 Hz meter readable, and changing them changes no audio behaviour. Both
halves are pure and cheap to test; the split follows who would want to change them.

### 7.5 Tokens

```ts
export type AccentToken = 'listening' | 'working' | 'speaking' | 'error' | 'muted';
export interface TokenModule {
  cssVariable(token: AccentToken | ChipToken): string;    // '--riki-accent-listening'
  contrastVariant(): 'normal' | 'high';
}
```

The values live in `tokens/tokens.css` as custom properties, not in TypeScript. Two reasons, one
of them non-obvious:

1. The lint rule in `eslint.config.js` rejects any hex literal under
   `apps/desktop/src/renderer/**`, and it has no exemption for the token module itself. A TS
   token module holding `#6FD3FF` would be rejected by the rule that exists to protect it.
2. CSS custom properties are where these values are consumed anyway, and the high-contrast
   variant is then a class swap rather than a re-render.

The "no red" test (§5.4) parses `tokens.css` and asserts no `#FF0000`-family value appears in the
accent palette. That is a Tier 1 test over a text file — no window, no renderer.

---

## 8. Integration points

Everything crossing into or out of this component, in one table. If a row is not here, the
overlay does not talk to it.

| Counterpart | Direction | Carried by | What flows |
|---|---|---|---|
| `trigger/` (hotkey) | in | `MachineInput.trigger` | down / up / tap / cancel |
| `@riki/realtime` | in | `VoiceBridge` | turn submitted, response started/ended, tool started/ended, faults |
| `@riki/realtime` | out | `VoiceCommandSink` | interrupt (barge-in → truncate), abort |
| `@riki/audio` | in | `VoiceBridge` | device faults, VAD silence/resume, level frames |
| `@riki/audio` | out | `AudioEffectSink` | earcons (capture start/end, error), ducking on/off |
| `@riki/events` | in | `PolicyBridge` | `unprompted.speechStarted` |
| `@riki/config` | in | `SettingsBridge` | anchor, scale, captions, timings, capture exclusion, mute |
| `crates/riki-capture` | in | display hint | the Dota window's bounds, for multi-monitor placement |
| `@riki/telemetry` | out | `TelemetrySink` | state transitions, the key-down→paint number, renderer faults |
| `tray/` | out | `projectTray` | the four tray states — same machine, different projection |

Two of these are the ones to get right:

**Barge-in** (ui-design §3.1: "the most important interaction in the whole design"). The trigger
arriving during Speaking produces one transition and one `voice.interrupt` effect carrying the
moment of interruption. `packages/realtime` owns what that means on the wire —
`conversation.item.truncate` with a plausible `audio_end_ms`, which the `voice-realtime` skill
flags as corrupting every later turn if it is skipped. The overlay's job is to make the edge
exist and to be in Listening before the user's second syllable; it is not to know the API.

**Ducking** is an effect of Speaking, not a side effect of the renderer. It ramps in over 120 ms
and out over 250 ms (ui-design §7.2) and must be disableable — which means the effect is emitted
unconditionally and `AudioEffectSink` honours the setting, rather than the machine branching on a
preference it should not have to hold.

---

## 9. Three paths in detail

### 9.1 Key-down to visible — the 100 ms budget

```
t+0    OS hook → trigger/ → SessionRuntime.dispatch({trigger: down})    [main, sync]
t+~0   reduce → phase armed, effects [window(true), levels(input), earcon, project, schedule]
t+~0   OverlayWindowController.showFast()          ← the only thing on the critical path
t+~1   webContents.send('riki:overlay:command', {model})
t+~3   renderer paints Armed; sends {intent: paint, revision}
t+~4   main records the delta                       → telemetry, and the e2e assertion
t+≤250 first level frames move the bars             ← the second budget, ui-design §8
```

What can break it, in the order it usually does: creating the window on demand (fixed by
`warm()`); a throttled background renderer (fixed by `backgroundThrottling: false`); waiting for
the audio device before showing (fixed by Armed existing at all — the chip's appearance never
waits on the mic); and an `await` between the hotkey and `showFast()`, which is why `dispatch` is
synchronous and why the `window` effect is applied first.

### 9.2 Barge-in

```
Speaking ──trigger down──► reduce ──► phase listening
                            effects [voice.interrupt(now), levels(input), earcon(captureStart),
                                     duck(off), cancel(all speaking timers), project]
```

One transition, no intermediate state, no round trip to the voice system before the chip changes.
The user sees Listening while the truncate is still in flight — which is correct: the interaction
already happened, and the UI should not wait for the network to acknowledge the user's own key
press.

### 9.3 Unprompted speech

```
Idle ──unprompted.speechStarted──► phase speaking (unprompted: true)
                                   effects [window(true), levels(output), duck(on), project]
```

No Armed, no earcon (the voice starting is its own cue, ui-design §7.1), and the chip fades in
over 80 ms. Barge-in from here is the same edge as §9.2, so the "Riki said something I do not
want to hear right now" case costs the player exactly one key press.

---

## 10. Failure, recovery, and idleness

### 10.1 The renderer crashes

The machine is in main, so nothing about the interaction is lost. `OverlayWindowController`
recreates and reloads the window; the renderer sends `intent: ready`; the presenter re-projects
the current model. The mic never closed, because the mic was never in that window (§3.2).

### 10.2 The voice session dies mid-turn

`VoiceBridge` emits a `fault`. The chip shows Error with text, holds for 4 s, and fades — unless
the fault is persistent (permission revoked, no device), in which case it stays until resolved
and the tray goes to `!`. The second identical fault in a session transitions silently
(`reported`, §4.2).

### 10.3 The player alt-tabs, changes resolution, unplugs a monitor

`display-metrics-changed` and focus changes re-run `PlacementResolver` and apply new bounds. If
the overlay is visible when that happens, it is re-placed without a state change — placement is
not interaction.

### 10.4 Idle really is idle

Three assertions, at three tiers, because "costs nothing" is the claim most likely to quietly
stop being true:

- Tier 1 — leaving a visible phase always emits `levels: { running: false }`.
- Tier 5 — with no session, `BrowserWindow.isVisible() === false` and
  `AnimationClock.framesRendered()` does not advance over a 2 s window.
- Tier 6 — the frame-time harness (`bench/frametime`) measures Dota's 1 % low with Riki idle;
  the target is no measurable delta.

---

## 11. Module boundaries

### 11.1 Rules the existing lint already holds

- Renderer may not import from `main/` — `boundaries/element-types` (§6.2). The bridge is the
  only path, and this design gives it exactly three functions.
- No raw colour literals under `renderer/**` — which is why the tokens are CSS (§7.5).
- No `console.*` outside `packages/telemetry` — which is why the renderer reports faults as
  intents (§6.2).
- No `process.env` outside `packages/config` — settings reach the machine as an injected
  `MachineEnvironment`.

### 11.2 Rules added when the code landed

All in `eslint.config.js`, each confirmed firing against a throwaway violating file before being
kept — the `workspace` skill's discipline, and it earned its keep here (see the note under the
table).

| Rule | Mechanism |
|---|---|
| `main/session/**` may not import `electron` | `boundaries/external` |
| `main/session/**` may not import `@riki/*` | `no-restricted-imports` |
| `main/overlay/**` may not import `@riki/realtime` or `@riki/audio` | `no-restricted-imports` |
| `renderer/**` and `shared/**` may not import `electron` or `@riki/*` | both |
| `renderer/**` may not import `main/**` **or `preload/**`** | `boundaries/element-types` |
| `main/session/**` may not import `main/overlay/**`, `preload/**` or `renderer/**` | `boundaries/element-types` |

Two of these are not where you would first put them, and the reasons are worth keeping.

**`@riki/*` cannot be a `boundaries/external` rule here.** That plugin only sees imports that
resolve, and a workspace package which is not a declared dependency of `apps/desktop` does not
resolve — so the rule reports success while catching nothing. `no-restricted-imports` matches the
literal specifier, which is what makes it fire *before* anyone adds the dependency. This is the
same trap as the `workspace` skill's first learning, one layer down.

**`preload/**` joins `main/**` on the renderer's disallow list.** The preload *implementation*
imports `electron`; a renderer that could import it would have Electron in it. That is why
`RikiOverlayBridge` — the bridge's type — is declared in `shared/overlay.ts` rather than beside its
implementation.

### 11.3 The build-config change — landed

`apps/desktop/tsconfig.json` was a single project with `lib: ["ES2023"]`, so renderer code could
not reference a DOM type at all — `HTMLElement` was `error TS2304`. It is now a solution config
over five projects: `tsconfig.shared.json`, `.main.json`, `.preload.json`, `.renderer.json` and
`.test.json`. The renderer gets `lib: ["ES2023", "DOM"]` and, deliberately, `types: []` — no
`@types/node`, which is what makes "no Node in the renderer" a type error rather than a code
review. Both directions were confirmed by writing a file that violates each and watching it fail.

Two things to know before editing them. The `include` globs must stay **disjoint**: under
`tsc --build` every file belongs to exactly one project, and an overlap is a duplicate-input error
rather than a merge. And a file that imports across a project boundary must have that project
listed in `references`, or the compiler rejects the import — which is how the renderer's attempt to
import the preload *implementation* (and with it, `electron`) was caught.

---

## 12. Claims to verify before building on them

Honesty about what has been measured, per house style. Everything in §3.3 comes from Electron and
Chromium documentation plus the headless learning already in the `overlay-ui` skill; none of it
has been measured against a game on this project's hardware. Before step 6 depends on any of it:

| Claim | How to check | Consequence if wrong |
|---|---|---|
| A warmed, hidden window shows in ≤100 ms including first paint | Instrument `showFast()` → `intent: paint` on a real build | The chip needs a persistent 1×1 window or a pre-rendered bitmap path |
| `backgroundThrottling: false` keeps a hidden renderer's rAF alive | Frame counter while hidden | Warm the renderer with a periodic no-op instead |
| `setContentProtection` excludes the overlay from OBS on macOS | Capture with OBS, both game-capture and display-capture | Say so plainly in settings; do not claim an exclusion we do not have |
| `setIgnoreMouseEvents` + `alwaysOnTop` survive borderless-windowed Dota | Manual, with the anti-cheat spike (B1) | The whole surface changes — see ui-design §6.5 |
| The chip renders over Dota in macOS *native* fullscreen, given `screen-saver` level plus `visibleOnFullScreen` | Manual, on a Mac, both fullscreen modes | Borderless-windowed becomes a hard requirement rather than a recommendation, and onboarding has to enforce it |
| 30 Hz IPC of level frames costs nothing measurable | `bench/frametime` with the chip visible | Move levels to a `SharedArrayBuffer` ring |

---

## 13. Testing map

Tiers are REPO_SKELETON §5.3. The point of the decomposition is that almost everything lands in
Tier 1.

| Unit | Tier | Asserts |
|---|---|---|
| `reduce` | 1 | The full state × input table, incl. barge-in, Esc from every phase, mute suppressing triggers, `reported` deduping repeat faults |
| `projectChip` / `projectTray` | 1 | Every state has a distinct glyph, and a distinct **(glyph, motion) pair**; tray collapses nine states to four |
| Timers | 1 | Each row of §4.6 fires once, is cancelled on exit, and honours the configurable nudge/timeout |
| `GestureRecognizer` | 1 | The 250 ms tap/hold threshold, both directions, at the boundary |
| `PlacementResolver` | 1 | Eight anchors × four scales × multi-display, incl. a display disappearing |
| `LevelBallistics` | 1 | Attack/decay against a known envelope; bar quantisation is monotonic |
| `MotionDirector.sample` | 1 | Deterministic for a given `t`; reduced-motion variants are static |
| Token palette | 1 | No `#FF0000`-family value in the accents (§5.4) |
| `SessionRuntime` | 4 | With a fake clock and fake window: `showFast()` is called in the same tick as the trigger; effects are applied in order; a renderer reload re-projects |
| Overlay messages | 3 | Once they move to `@riki/protocol` — round-trip through the contract corpus |
| ChipView, BarsView, TextSlot, CaptionPanel, `mountOverlay` | 1 | Attributes, `scaleY`-only frames, captions off by default, the clock stopping on a settled state. In an in-memory DOM (`happy-dom`), which needs no game, microphone, GPU or window and so still satisfies §5.2 |
| The window | 5 | ≤100 ms key-down → paint; hidden means not visible and not painting; reduced motion and high contrast; captions off by default; Esc cancels; barge-in returns to Listening |
| Idle cost | 6 | Dota 1 % low with the chip idle and visible (`bench/frametime`) |

Tier 5 is the only tier that launches a window, and per the `overlay-ui` skill it needs
`xvfb-run -a dbus-run-session -- …` on a headless box.

---

## 14. Open questions this closes, and what it leaves

Closed, with the answer recorded here rather than in three documents:

- **ui-design §13.1 — "does Riki need an input path beyond voice?"** Answered twice, and the
  second answer is *no*. It was yes-and-narrow: scoped `Y`/`N`/`Esc` accelerators registered only
  while Confirming, because a click-through window can take no pointer input at all. ADR-0023 then
  deleted the only consequential action Riki had, so there is nothing to confirm and no
  accelerator to scope (§4.4). Voice and the push-to-talk binding are the whole input surface.
- **ui-design §13.5 — multi-turn conversation.** The machine already models it: Speaking →
  trigger → Listening is one edge, and nothing in the state model assumes a turn is the last one.
  The "session active" affordance the question asks about is the latched-mode border (§4.2).
- **ui-design §13.6 — "does Riki have anything to say unprompted?"** dota2 §6.4 says yes, so the
  state model needs the Idle → Speaking edge (§4.3). Recorded here because the two documents
  disagreed and the answer was only in one of them.

Left open:

- **B1, the anti-cheat spike.** Unchanged and still blocking.
- **ADR-0010's ownership question.** The voice window is proposed here because the overlay needs
  to know where levels come from; the agent who builds `packages/realtime` owns the decision.
- **Caption redaction.** Captions render whatever text they are given. Who scrubs other players'
  chat before it becomes a caption is a `packages/context` question, not an overlay one — but the
  overlay is where the leak would be visible, so it needs an owner before captions ship.

---

## 14a. Decisions the implementation had to make

The design left these open by omission; recorded here rather than only in code comments.

| Question | Decision | Why |
|---|---|---|
| A persistent fault blocking the trigger | It does not: the key re-arms from Error | The window is click-through, so `Fix ▸` is a hint, not a button. Refusing the key would leave the chip with no recovery path at all. The second identical fault is deduped, so a failed retry costs one silent return to Idle |
| Tray `attention` | Read off `reported`, not off the Error phase | A revoked microphone outlives the four seconds of Error chip, and the tray is the surface that must keep saying so |
| Fault dedupe scope | Persistent faults only | "Fail loudly but only once" (§1.6) is about a broken mic. A second "didn't catch that" is news, not nagging |
| Trigger during Processing | Aborts the turn and starts a new capture | The player has something else to say; queueing behind an answer they have stopped waiting for is worse than dropping it |
| `responseEnded` in a latched session | Returns to Listening, not to Idle | That is what latching means, and it is the "session active" affordance §14 promised |
| Speaking's `⌥Space ✕` hint | Not rendered | Rendering it means naming the bound key, which the machine does not know — `trigger/` owns the binding and is a sibling task. Still open |

## 15. Build order

Nothing here can land before REPO_SKELETON §10 step 6, and step 6 cannot start before the
anti-cheat spike. Within that, the order that keeps every step testable:

1. `shared/overlay.ts` + `session/machine.ts` + its Tier 1 table. No Electron, no window; this is
   the bulk of the logic and all of it is testable today.
2. `SessionRuntime` + fakes for every sink. Tier 4 without a window.
3. `OverlayWindowController.warm()` + `showFast()` + the Playwright harness. The 100 ms number
   exists from here on and regressions are visible.
4. The renderer: tokens, ChipView, MotionDirector, BarsView. Tier 5 fills in.
5. Adapters, as the packages they adapt land — `VoiceBridge` after step 7, `PolicyBridge` after
   `packages/events`.
6. Move the wire types into `packages/protocol` (§6.3) and add the contract fixtures.

Steps 1 and 2 are worth doing even if B1 fails and the surface changes, because a pure
interaction machine outlives the window it was drawn in.

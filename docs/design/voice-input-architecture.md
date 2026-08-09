# Riki — Voice Input Architecture

**Status:** Built. Every section here has an implementation and Tier 1 tests behind it, and the
whole path — capture → gate → transport → transcript → local command — runs against fakes with no
browser, no microphone, no socket and no key. The browser primitives (`getUserMedia`, the Web
Audio nodes, `RTCPeerConnection`, `WebSocket`, `fetch`) all arrive through structural ports, which
is what makes that true; the adapters that supply the real ones land with the voice window.

Two things are deliberately still outstanding: **`EarconPlayer`**, which needs a real
`AudioContext` to make a sound (its specification table is implemented and tested), and the
**composition root** in `apps/desktop`, which is §14 step 7 and a separate task.
**Scope:** The voice path end to end — microphone capture and gating, the real-time audio
pipeline, the OpenAI Realtime session, transcription and local command parsing, and the class and
method structure of `packages/audio` and `packages/realtime`.
**Reads with:**
[`openai-realtime-research.md`](../research/openai-realtime-research.md) is what the *outside
world* does; this document is what *we* do about it and does not restate it.
[`overlay-architecture.md`](overlay-architecture.md) owns the interaction state machine — this
component supplies its inputs and executes its effects.
[`context-and-memory-architecture.md`](context-and-memory-architecture.md) owns what the model is
told and what should leave the window; this component owns the wire.
**Out of scope:** The chip and the tray (overlay §4), hotkey capture per platform (ui-design §6.4),
the decision to speak unprompted (`packages/events`, dota2 §6.4), what the snapshot says
(`packages/context`), and where the API key comes from (ADR-0006).

---

## 0. Assumptions

Sections marked ⚑ are what changes if one of these is wrong.

| #  | Assumption | Source | Affects |
|---|---|---|---|
| V1 | WebRTC is the transport, so a Chromium renderer owns `getUserMedia` and the peer connection | ADR-0002, REPO_SKELETON A2 | ⚑ §3, §5.2 — the whole capture design inverts on WebSocket |
| V2 | Push-to-talk is the default trigger; the mic is not open between utterances | ADR-0004 | ⚑ §3.1, §6.2 |
| V3 | A permanently hidden **voice window** hosts this component's renderer half | ADR-0010 (Proposed) | ⚑ §2.2 |
| V4 | The API key is an environment variable read only by `packages/config` in **main** | ADR-0006, REPO_SKELETON §7.1 | ⚑ §5.1, ADR-0015 |
| V5 | The GA (`gpt-realtime-2.1`) session schema, not the beta one | realtime §3 | ⚑ §5.3 |
| V6 | One session per match: 35–45 min of play against a 60-minute session cap | dota2 §1, realtime §1 | ⚑ §5.7 |
| V7 | No test may open a live session, use a real microphone, or spend money | REPO_SKELETON A6, §5.2 | ⚑ §11 — every seam here exists partly to be fakeable |

**V1 is the one that shapes the most.** Under WebRTC, audio never passes through our code as PCM
on the common path: Chromium captures it, encodes Opus, and sends it over RTP. That single fact
decides where resampling lives (§4.2), how barge-in is measured (§4.3), why the mic gate is a gain
node rather than a buffer (§3.2), and why `packages/audio` is mostly *pure maths plus one graph*
rather than a streaming pipeline.

**V3 is not settled.** ADR-0010 is Proposed rather than Accepted precisely because it constrains
this component's host. Nothing below depends on which renderer it is, only that it is one that is
never hidden, never reloaded for cosmetic reasons, and not the overlay's.

---

## 1. What this component is

Four things, and keeping them apart is most of the architecture:

1. **A capture path** — one Web Audio graph in the voice window that owns the microphone, gates
   it, measures it, and hands a track to WebRTC.
2. **A session** — the Realtime connection: credentials, transport, configuration, the event bus,
   and the window mechanics `packages/context` plans.
3. **A turn controller** — the thing that knows a turn is a *gesture*, not a VAD event: when to
   commit, when to create a response, when to truncate, and what to do when the player interrupts.
4. **Two parsers** — the transcript stream, and a small anchored phrase grammar for the handful of
   spoken commands that must work when the model is unavailable.

### 1.1 Non-goals

- **This component does not decide what state the interaction is in.** The overlay's
  `InteractionMachine` does (ADR-0009). We emit vendor-free facts — `turn.submitted`,
  `capture.opened`, `speech.silence` — and execute `VoiceCommand`s. If a rule here needs to know
  whether the chip is in Listening, the rule is in the wrong package.
- **This component does not decide what the model is told.** `packages/context` assembles the
  preamble, the snapshot and the tool manifest; we put them on the wire in the right order.
- **This component does not hold conversation state.** ADR-0012 is explicit that the ledger is
  ours-not-theirs, and it lives in `packages/context`. What we keep is what the *wire* needs: item
  ids, the current response, token usage, and how many milliseconds of it the player actually
  heard.
- **This component never reads `process.env`.** REPO_SKELETON §6.2 makes that a lint boundary, and
  §5.1 is the design that makes it easy to obey.

---

## 2. Decomposition and topology

### 2.1 At a glance

```
┌───────────────────────── Electron main ──────────────────────────┐
│  @riki/config ──► apiKey ──► ClientSecretBroker  (@riki/realtime)│
│                                    │ ephemeral secret only       │
│  @riki/context ──► SessionContext, TurnContext, WindowPlan       │
│  @riki/events  ──► "speak now"                                   │
│  tools pipeline ◄── tool calls / consent ──► results             │
│  session/InteractionMachine ◄── VoiceEvent ── VoiceBridge        │
│                             ──► VoiceCommand ─►                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ preload bridge (voice window)
                               │ no PCM, no key — see §2.3
┌──────────────────────────────┴───── voice renderer (hidden) ─────┐
│                                                                  │
│  @riki/audio                        @riki/realtime               │
│  ┌────────────────────────────┐     ┌──────────────────────────┐ │
│  │ DeviceRegistry             │     │ RealtimeSession          │ │
│  │ CaptureGraph               │────►│   TurnController         │ │
│  │   mic→analyser→delay→gate  │track│   WebRtcTransport        │ │
│  │ LevelMeter (pure maths)    │     │   SessionConfigBuilder   │ │
│  │ PlaybackTracker            │◄────│   ContextWindowExecutor  │ │
│  │ EarconPlayer               │remote   CostMeter              │ │
│  └────────────────────────────┘     │   TranscriptStream       │ │
│                                     │   LocalCommandParser     │ │
│                                     └────────────┬─────────────┘ │
└──────────────────────────────────────────────────┼───────────────┘
                                                   │ WebRTC: media + oai-events
                                                   ▼
                                          OpenAI Realtime API
```

### 2.2 Who hosts what, and why

| Piece | Host | Why it cannot be elsewhere |
|---|---|---|
| `ClientSecretBroker` | main | It is the only thing that touches the API key (ADR-0015) |
| `CaptureGraph`, `PlaybackTracker`, `EarconPlayer` | voice renderer | `getUserMedia`, Web Audio and Chromium's AEC exist only in a renderer (ADR-0002) |
| `RealtimeSession` + transport | voice renderer | The peer connection has to be where the tracks are |
| Level *maths* | `packages/audio`, anywhere | Pure functions over `Float32Array`; unit-tested with no audio device |
| Level *ballistics* | overlay renderer | Display decisions, not audio ones — overlay §7.4 draws this line and it stands |
| `Ducker` implementation | main | It is an OS call (WASAPI session ducking on Windows; see §4.4 for macOS); `packages/audio` declares the interface only |
| `LocalCommandParser` | `packages/realtime`, anywhere | A pure function from a transcript to at most one command |

### 2.3 What crosses the preload bridge

Never: raw PCM, the API key, or a `MediaStreamTrack`. ADR-0002 already committed to the first;
ADR-0015 covers the second; the third is a consequence of the peer connection living entirely on
one side.

What does cross, per turn: an ephemeral client secret (main → renderer, once per session), the
`SessionContext` and `TurnContext` values from `packages/context`, `VoiceCommand`s, tool calls and
their results, and a `VoiceEvent` stream back. Level frames cross at 30 Hz while the chip can show
bars and not otherwise (overlay §5.5). All of it is `packages/protocol`'s to schematise — §12.

### 2.4 Directory layout

```
packages/audio/src/
├── types.ts        vocabulary: MonoMs, LevelSample, faults, the opaque media handles
├── device.ts       enumeration, permission, opening and losing a microphone
├── capture.ts      the graph: gate, pre-roll delay line, level tap
├── level.ts        rms / peak / dbfs / envelope — pure
├── resample.ts     48k↔24k, PCM16 conversion, streaming phase — pure
├── playback.ts     PlaybackTracker: audible milliseconds and the output envelope
├── earcons.ts      three synthesised tones (ui-design §7.1)
├── ducking.ts      the Ducker interface; implementations live in apps/desktop/src/main
└── testing/        FakeAudioDevice

packages/realtime/src/
├── types.ts        ids, faults, usage, the VoiceEvent union the overlay adapter consumes
├── credentials.ts  ClientSecretBroker (main) + the port the renderer sees
├── session-config.ts  the GA-shaped session.update builder and its guard
├── transport.ts    RealtimeTransport + WebRtcTransport + WebSocketTransport
├── wire.ts         the narrow slice of the API's event vocabulary we name
├── turn.ts         TurnController: commit, create, truncate, cancel
├── window.ts       ContextWindowExecutor — the mechanism half of ContextWindowPort
├── transcript.ts   TranscriptStream
├── commands.ts     LocalCommandParser — pure
├── cost.ts         CostMeter
├── session.ts      RealtimeSession, RealtimeSessionHandle, SessionSupervisor
└── testing/        FakeRealtimeTransport
```

---

## 3. Capture

### 3.1 The device is opened per match, not per key press

The naive reading of "push-to-talk means the mic is closed" is `getUserMedia` on key-down and stop
the tracks on key-up. It does not survive contact with the budgets: opening a capture device costs
somewhere between 50 and 300 ms depending on the platform and whether the device is shared, which
spends the whole ≤100 ms key-down→visible budget and all of the ≤250 ms bars-respond budget on
something the player experiences as the app being broken. It also makes the OS microphone
indicator blink once per utterance, which reads as malfunction rather than as privacy.

So the device is opened when a match starts and released when it ends, and **the gate is a gain
node inside our own graph** (ADR-0016). While the gate is closed the outbound track carries
digital silence: nothing is transmitted that could be heard, and — because the gate is upstream of
the track, not a `track.enabled` flag — nothing reaches the encoder either.

The honest cost is that the OS shows Riki as using the microphone for the whole match. That is
disclosed in onboarding, mirrored by our own indicator, and is arguably the more truthful state to
be in: the app *can* hear, and the thing stopping it is our code.

### 3.2 The graph

```
getUserMedia({ echoCancellation, noiseSuppression, autoGainControl })
        │
        ▼
  MediaStreamSource ──► AnalyserNode ──────────────► LevelMeter ──► level frames (30 Hz)
        │                (pre-gate, always running)
        ▼
   DelayNode(preRollMs) ──► GainNode(gate) ──► MediaStreamDestination ──► RTCPeerConnection
```

Three properties of this arrangement carry decisions rather than taste:

- **The analyser is upstream of the gate and runs whenever the device is open.** It is what lets
  `speech.silence` / `speech.resumed` exist for the machine's silence-nudge and 8 s listen-timeout
  (overlay §4.6) without asking the server, and it costs one FFT-free RMS pass per frame.
- **The gate ramps, it does not switch.** A step change in gain is a click, and a click at the
  start of every utterance is both audible and something the model will occasionally interpret as
  speech. `gateRampMs` defaults to 8 ms.
- **The delay node is the pre-roll**, and it is the subtle one — §3.3.

### 3.3 Pre-roll is a delay line, and it costs latency

ui-design §3 gives Armed a job: *"pre-roll buffering means audio from before the key press is
retained"*, so the first syllable is not clipped by the reflex gap between starting to speak and
finishing the key press. Under WebRTC there is no way to inject a buffer into an RTP stream after
the fact — the stream is real time by construction. Buffering samples and then playing them faster
than real time to catch up would need resampling and would pitch-shift exactly the words we were
trying to save.

What does work is running the outbound leg permanently late. With a `DelayNode` of `preRollMs`,
the samples arriving at the gate at wall-clock *t* were captured at *t − preRollMs*. Opening the
gate at key-down therefore emits audio from before the key-down, with no buffer flush and no rate
trickery.

The cost is that **every utterance is `preRollMs` later than it needs to be**, end to end. Against
the ~1–1.5 s conversational turnaround this document plans for (realtime §7), a 200 ms default is
roughly 15% and is worth the first syllable; at 400 ms it would not be. It is a setting, it is
allowed to be zero, and §13 lists measuring the reflex gap on real users as the way to pick the
number rather than the way it was picked here.

### 3.4 What echo cancellation does and does not cancel

AEC is why the shell is Electron (ADR-0001) and it is not optional: without it the model hears its
own voice and interrupts itself in a loop (realtime §11.5). Two things about it are easy to get
wrong here:

- **It cancels *our* output, not Dota's.** Chromium's echo canceller references the browser's own
  render stream. Riki's speech goes out through this renderer, so it is cancelled. Dota 2 is a
  different process, and on every platform we target its audio is not in that reference — so combat
  audio reaches the model as ambient noise. That is what `noise_reduction` is for (`far_field` for
  a desk mic, `near_field` for a headset — the common case for this audience), and it is another
  reason the gate is closed by default: the mic is only open while a player is deliberately
  talking over their own game.
- **Routing capture through Web Audio must not disable it.** AEC is applied by the capture
  pipeline upstream of `MediaStreamSource`, so the graph in §3.2 should keep it. "Should" is not
  "does": this is listed in §13 as a claim to verify with a measurement — play a tone out of the
  renderer, capture through the full graph, assert attenuation — before anything is built on it.
  If it does not hold, the delay line moves behind a `MediaStreamTrackProcessor` or pre-roll is
  abandoned; the rest of the design is unaffected.

### 3.5 Device loss, device change

Unplugging a headset mid-match is ordinary, not exceptional. `DeviceRegistry` watches for device
change, and `CaptureGraph.replaceStream()` swaps the source node without touching the gate, the
delay, the track identity, or the peer connection — so a swap does not renegotiate SDP and does
not interrupt a turn in flight. If no input device remains, the fault is `no-input-device` and it
is persistent (overlay §10.2): the chip stays in Error until it is resolved, because a voice coach
with no microphone should not quietly look idle.

---

## 4. The processing pipeline

### 4.1 Two legs and two rate domains

| Leg | WebRTC path (default) | WebSocket path (`RIKI_REALTIME_TRANSPORT=websocket`) |
|---|---|---|
| Capture rate | Device rate (typically 48 kHz), our graph never resamples | Device rate → **24 kHz PCM16 LE** by us |
| Encode | Opus, by Chromium | None — base64 PCM16 in `input_audio_buffer.append` |
| Playback | Remote track → `<audio>`, jitter buffer by Chromium | `response.output_audio.delta` → our own scheduler |
| Barge-in truncation | Server-side while VAD is on (§5.5) | Ours, with a measured `audio_end_ms` |
| Who owns packet loss | Chromium | Us, badly (realtime §2) |

### 4.2 Resampling belongs to the WebSocket path — and to the tests

REPO_SKELETON §2.2 and the `voice-realtime` skill both list resampling as a `packages/audio`
responsibility, and the 48 kHz→24 kHz→48 kHz round-trip tone test is named in §5.4 as
non-optional. Under WebRTC none of that runs in the product's default path, and it would be easy
for the next agent to conclude the tests are therefore theatre. They are not, for two reasons that
are worth writing down once:

1. `RIKI_REALTIME_TRANSPORT=websocket` exists in `.env.example` (ADR-0002 keeps it explicitly so
   the path can be exercised), and on that path a resampling bug is a pitch-shifted session that
   sounds like a bad model rather than like a bug.
2. `FakeAudioDevice` feeds known PCM at a known rate, and every fixture in `fixtures/realtime/`
   was recorded at 24 kHz. Fixture-driven tests resample even when the product does not.

The one thing implementations get wrong here is chunk boundaries: resampling each frame
independently drops or duplicates a fraction of a sample per frame, which is inaudible per frame
and a slow drift plus periodic clicks over a match. `StreamingResampler` carries the fractional
phase between calls, and that is the only reason it is a class rather than a function.

### 4.3 Playback tracking, and the number barge-in depends on

`conversation.item.truncate` needs `audio_end_ms` — how much of the response the player *actually
heard*. Getting it wrong in either direction corrupts every later turn (realtime §4): too high and
the model believes it said things that were cut off, too low and it repeats itself.

Under WebRTC we cannot count deltas, because the audio arrives as RTP and not as events. What we
can do is measure the output: `PlaybackTracker` runs an analyser on the remote track and
accumulates milliseconds during which the output is above a silence floor, reset at each
`response.created`. That gives an `audibleMs` that includes jitter-buffer delay and excludes
trailing silence, which is exactly the quantity meant.

It pays for itself twice: the same analyser produces the output envelope that drives the chip's
bars during Speaking (ui-design §3), so Speaking's level source is a by-product of the barge-in
machinery rather than a second measurement of the same signal.

### 4.4 Earcons and ducking

Both are effects the overlay's machine emits (`AudioEffectSink`), and both are ours to execute.

**Earcons are synthesised, not sampled.** ui-design §7.1 specifies them as frequencies and
durations — 660→880 Hz rising, 880→660 Hz falling, 330 Hz for error, ~80 ms, soft attack — so an
oscillator and a gain envelope reproduce the spec exactly, in about twenty lines, with nothing to
ship in `resources/` and nothing to keep in sync with the document. They play in the voice
window's own context so they are never gated by the mic gate and never appear in the outbound
track.

**Ducking is an OS call and `packages/audio` only declares it.** `Ducker` has three methods and a
platform-dependent `available`; a no-op implementation is a legitimate implementation and reports
itself as unavailable rather than silently pretending. −12 dB with a 120 ms ramp in and 250 ms out
(ui-design §7.2), disableable, and the disable check lives in the sink rather than in the machine
(overlay §8).

> **Verified, and it holds** ([ADR-0020](../adr/0020-ducking-is-a-no-op-by-default.md),
> [audio-ducking-platform-support.md](../research/audio-ducking-platform-support.md)). macOS has
> **no public API** for attenuating another application's audio — `duckOthers` is
> `API_UNAVAILABLE(macos)`, and every third-party tool that does it installs an audio HAL plug-in.
> So `createNoopDucker()` is the **default** path on the primary platform, and it must be silent:
> no fault, no log, no retry. Windows ducks only through a communications-role stream whose depth
> and ramp the OS picks, so §7.2's figures are honoured on Linux alone. The consequence this
> leaves open is §7.2's own rationale — "TTS is unintelligible over combat audio" is now an
> unmitigated risk for most users (docs/README.md open question 17).

---

## 5. The Realtime session

### 5.1 Credentials: minted in main, spent in the renderer

The constraint stack looks contradictory at first. ADR-0002 puts the peer connection in a
renderer. ADR-0006 says the API key is an environment variable. REPO_SKELETON §7.1 says the key is
read in exactly one module, in main, and never crosses the preload bridge. A renderer that must
authenticate to OpenAI and must never hold the credential to do it.

The Realtime API already has the answer, and it is the mechanism research §2 describes for
browsers: `POST /v1/realtime/client_secrets` with the real key returns a short-lived client
secret, and the client authenticates the SDP exchange with that. We are our own token-minting
service, in-process, with the "server" being the Electron main process (ADR-0015).

```
main                                            renderer (voice window)
────                                            ───────────────────────
config.apiKey ──► ClientSecretBroker.mint(cfg)
                        │  POST /v1/realtime/client_secrets
                        ▼
                  { value, expiresAt, sessionId } ──preload──► RealtimeSession.open()
                                                                    │ POST /v1/realtime/calls
                                                                    ▼  Authorization: ephemeral
```

Three consequences worth stating:

- The key never leaves main, so §5.4's "assert the key is absent from the preload bridge surface"
  test is a statement about a surface that structurally cannot carry it.
- Secrets expire. `mint()` is called again on reconnect and on rotation (§5.7), which means the
  renderer must handle "my credential is stale" as an ordinary event rather than as a fatal error.
- `OpenAI-Safety-Identifier` is set by the broker from a hashed local install id, never by the
  renderer — research §6 is explicit that a client-supplied value is worthless, and dota2 §7 says
  the Steam ID is hashed before any egress. Both point at the same place.

When the swap in REPO_SKELETON §11.2 happens — a real minting service for distributed builds — it
replaces `ClientSecretBroker`'s implementation and nothing else. That is the whole reason the seam
is here rather than in the renderer.

### 5.2 Transport

One interface, three implementations, and the third is the one every test uses.

`WebRtcTransport` owns the peer connection, the `oai-events` data channel (the name is not
negotiable — research §2), and the SDP exchange. `WebSocketTransport` owns a socket plus the PCM
framing from §4.1 and the manual barge-in path from §5.5. `FakeRealtimeTransport` replays
`fixtures/realtime/*` and records what we sent, which is what makes the schema assertion in §11
possible at all.

The interface deliberately does not abstract over *media*: the two transports take different media
arguments (`TransportMedia` is a discriminated union of a track and a PCM stream) because
pretending a `MediaStreamTrack` and a chunk of PCM are the same thing would put a fake abstraction
exactly where the real difference is.

### 5.3 Session configuration, and the schema trap as a type

The beta/GA confusion (research §3) is the single most common integration failure, it does not
error, and it silently degrades the session. Three layers stop it here, in decreasing order of
how much they can be trusted:

1. **`RealtimeSessionConfig` is our vocabulary, not theirs.** Nothing outside `session-config.ts`
   constructs a wire payload. A caller supplies a voice and a model; it cannot supply a
   `input_audio_format` string because the type has no such field.
2. **`buildSessionUpdate()` is the only producer**, and it emits the GA nesting —
   `audio.input.format = { type: 'audio/pcm', rate: 24000 }`, `audio.output.voice` — with no
   top-level `voice`. Interleaving the two schemas is worse than either (research §3, and the
   `openai-agents-js` bug it links).
3. **`assertGaShape()` runs on the outgoing payload in development and in tests**, and §11's
   golden test snapshots it. A snapshot diff is how a future SDK bump that reintroduces a legacy
   field becomes visible.

The reason for all three rather than one: the failure is silent, so we cannot rely on noticing it.

### 5.4 Turn-taking: VAD stays on, response creation is ours

Push-to-talk is often implemented as `turn_detection: null`, and research §4 describes that as
what push-to-talk *is*. Riki uses the middle ground instead — VAD enabled with
`create_response: false` — for a reason that only shows up on the WebRTC path (ADR-0017):

**Server-side barge-in truncation is a VAD feature.** Research §4 says WebRTC handles interruption
server-side "nothing to do", and §4's manual four-step truncation is presented as the WebSocket
problem. That server-side behaviour is driven by the server noticing the user speaking, which is
VAD. Disable turn detection and the convenience disappears — leaving us hand-rolling the exact
thing the transport was chosen to avoid.

So: VAD on, `create_response: false`, `interrupt_response: true`. We keep the gesture as the
authority over when a response happens, and we keep server-side truncation for the common
interruption. The gate makes it safe — with the mic gated, VAD only ever sees audio the player
deliberately sent.

One sharp edge falls out of it. With VAD on, the input buffer is committed when the server sees
speech *stop*, so sending `response.create` the instant the key is released can race the tail of
the utterance. `TurnController` waits for `input_audio_buffer.speech_stopped`, bounded by
`commitGraceMs` (default 400 ms), and `silence_duration_ms` is configured low (200 ms) to keep
that wait short. Both numbers are settings; both are on the release→response path, so both are in
the latency table in §8.4.

### 5.5 Barge-in

The overlay makes the edge exist in a single transition and does not wait for us (overlay §9.2).
Our half:

| Situation | What we send | Why |
|---|---|---|
| Player holds the trigger during Speaking | Nothing, on the WebRTC path — the server truncates on `speech_started` (§5.4). We still record `PlaybackTracker.audibleMs` for the ledger | Doing both would truncate twice, at two different offsets |
| The same, on the WebSocket path | `conversation.item.truncate(itemId, audibleMs)` | Nothing else will |
| `Esc` / abort, with no speech | `response.cancel` **and** `conversation.item.truncate(itemId, audibleMs)` | The player heard part of it; VAD never fired, so no server-side truncation happens |
| Local `stop` command (§6) | Same as abort | Same reason |

The third row is the one that is easy to miss, and it is the row that produces the corrupted-model
failure the `voice-realtime` skill warns about: a cancel without a truncate leaves the model
believing it finished a sentence the player cut off.

### 5.6 The context window: policy there, mechanism here

`packages/context` decides what should leave the window and what replaces it, and hands over a
`WindowPlan` (context §8.4). `ContextWindowExecutor` is the other half of that port. It:

- Maps `LedgerRef`s to conversation item ids — the mapping is ours because item ids are a wire
  concept and the ledger deliberately does not know them.
- Applies deletions and the replacement summary item in an order that never leaves the
  conversation without its summary: create the summary item first, then delete what it replaces.
- Reports what actually happened as `AppliedWindowPlan`, including partial failure. A delete that
  the API refuses is a `failed` ref, not an exception.
- Reports **API-initiated truncation** through `onDropped(..., 'api_truncation')`. Context §6 calls
  a non-zero count here a bug rather than a condition, and it is: it means our accounting let the
  API reach the ceiling first, which takes the cached prefix and makes Riki forget who it is before
  it forgets what it just said.
- Sets `truncation.retention_ratio: 0.8` and, when `RIKI_LOG_LEVEL=debug`, `truncation:
  "disabled"` so that in development the ceiling is an error rather than a silence (research §5).

`usage()` returns what the session reported and `null` when nothing has been reported yet — never
an estimate. Context's own estimator is deliberately conservative and its drift against this number
is a telemetry signal there (context §7.6); handing it a guess dressed as a measurement would
destroy the only ground truth in that loop.

### 5.7 Session lifetime

One session per match (V6). It opens at match start rather than at first press, for two reasons:
the cached prefix is paid once and warm before it is needed, and SDP negotiation is ~300–500 ms
that would otherwise land on the player's first utterance. An idle session costs nothing —
billing is per token and no tokens flow while the gate is closed (research §10).

Against the 60-minute cap, a 45-minute match plus draft plus post-game can run over.
`SessionSupervisor` rotates at `rotateAfterMs` (default 50 min): open a second session, replay the
byte-identical preamble and `ContextAssembler.rehydrate()`'s summary into it, then swap and close
the first. The player hears nothing; the cost is one cold prefix.

Reconnection after a transport failure is the *same* machinery with a different trigger, which is
the main reason rotation is worth building rather than accepting a hard stop at 60 minutes — the
reconnect path is not optional and this makes it exercised on every long match instead of only
when the network fails.

> **⚠ Built, and in the other process — [ADR-0045](../adr/0045-a-session-is-renewed-from-main-and-the-conversation-does-not-carry.md).**
> The paragraphs above are right about *when* and wrong about *where*, and about what carries.
>
> `SessionSupervisor` here stays a declaration: rotating needs a fresh client secret, minting needs
> the `ApiKey`, and ADR-0015 keeps the key in main — the voice window's `CredentialPort.acquire()`
> resolves the constant it was handed. Renewal is `apps/desktop/src/main/voice/session.ts`, which
> mints and sends `voice.session.open` again; the renderer's handler already closes the live session
> before opening a new one, so no message and no mechanism had to be added. What this package keeps
> is *detection*: the `session_expired` code, a transport that closed without being asked to, and
> one fault per loss when both arrive.
>
> `ContextAssembler.rehydrate()` no longer exists — ADR-0042 deleted the ledger it summarised. **The
> instructions carry across and the conversation does not**, which is survivable precisely because
> Riki now answers from a snapshot rendered fresh on each turn rather than starting turns of its own.

### 5.8 Cost

Research §10 puts cost accounting in this package so the lever stays visible, and §11.1 warns that
cost scales with engagement with no ceiling but the one we build. `CostMeter` records reported
usage per turn and exposes a per-match `CostSnapshot`. Worked example, mini rates, a 40-minute
match with 20 turns:

| Component | Tokens | At mini rates |
|---|---|---|
| Input audio: ~3 min of gate-open speech | ~1,800 | ~$0.02 |
| Output audio: 20 turns × ~8 s | ~3,200 | ~$0.06 |
| Context replay: 20 turns × ~4k | ~80,000 | **$0.80 uncached, ~$0.10 cached** |

Which says the only number that matters is the cached fraction, and that a design that busts the
cache — frequent small truncations (research §5), a rotating preamble, a manifest that changes
mid-session (ADR-0011) — costs multiples rather than percentages. The budget default is $1.00 per
match; on crossing it Riki says so once and stops opening new turns, because a coach that silently
stops working is worse than one that says it has run out.

---

## 6. Transcription and command parsing

### 6.1 Where a transcript comes from

Speech-to-speech means there is no transcript unless we ask for one:
`audio.input.transcription` configures a separate ASR pass over the input, delivered as
`conversation.item.input_audio_transcription.completed`. Riki enables it, for three consumers, none
of which is the screen:

- `packages/context`'s ledger, which records `player_said` and `agent_said` (context §6.2).
- The local command parser (§6.3).
- Captions, which remain **off by default** (ui-design §9.3) — enabling transcription and
  displaying it are different decisions and only the first is made here.

Two caveats that will otherwise be discovered as bugs. The transcript is produced by a *different
model* from the one that heard the audio, so it is an approximation of what was heard rather than
a record of it — do not use it to reconstruct model state. And it costs: a small per-minute ASR
charge on top of the audio tokens, which is why it is a setting and not a constant.

### 6.2 Two kinds of "command", and only one of them was ever ours

"Command parsing" in a voice product usually means turning speech into intents. Here, most of that
job used to belong to the model and arrive back as a tool call — `get_enemy_detail`, `read_screen`.
**ADR-0023 deleted that half entirely** (`coaching-architecture.md` §7.1) and
[ADR-0042](../adr/0042-riki-answers-questions-instead-of-deciding-when-to-speak.md) brought a
different half back: the session advertises five *read-only* tools over the world model, dispatches
what the model calls, and answers with a `function_call_output`. Nothing a tool returns is an
action — `my_state`, `enemy`, `objectives`, `economy`, `world_at` all answer questions and change
nothing — so the distinction this section draws survives the reversal intact. A call that cannot be
answered comes back as `{ unknown: reason }` rather than as silence
([ADR-0049](../adr/0049-a-failed-tool-call-is-an-unknown-not-a-silence.md)), and a session with no
dispatcher injected still sends `tools: []` and counts what arrives.

What is left is the only thing in Riki that turns speech into an action — a short list of **control
phrases that must work when the model is unavailable, slow, or misbehaving**. They matter *more*
after that deletion, not less: under proactive coaching Riki speaks when the player is holding
nothing, so `quiet-mode` — "only when I ask" — is the off switch for the primary path, and it must
work with the model down.

| Phrase class | `LocalCommand` | Effect |
|---|---|---|
| "stop" / "that's enough" / "shut up" | `stop` | Cancel the response and truncate (§5.5) |
| "mute" / "mute for ten minutes" | `mute` | Machine input `mute: true`, with an optional duration |
| "only when I ask" | `quiet-mode` | `RIKI_UNPROMPTED=off` for the session (dota2 §6.4) |
| "never mind" / "cancel that" | `cancel` | Abort the turn without a response |

**Honesty about how much this earns.** Under the default push-to-talk it earns very little: the
player must hold the trigger to be heard at all, and holding the trigger during Speaking *is*
barge-in, which already stopped Riki before a word of the phrase was parsed. These commands matter
in tap-to-latch (ui-design §6.2), where the mic stays open without a held key, and in the opt-in
wake-word mode. They are built because those modes exist, not because push-to-talk needs them —
and if latch mode were cut, this parser would go with it.

### 6.3 The grammar, and why it is anchored

`parseLocalCommand()` is a pure function from a transcript to at most one match. Its rules are
short and all of them exist to avoid false positives, because the failure mode of a false positive
is Riki muting itself in the middle of a fight:

- **Whole-utterance or final-clause matching only.** A phrase must be the entire transcript or its
  last clause. "Don't stop farming" contains "stop" and must not match; "okay, stop" must.
- **Normalised edit distance, with a floor.** Transcription of a short phrase is noisy; exact
  matching would fail on "shuddup". The threshold is per-command and higher for the ones that are
  annoying to recover from.
- **A negation guard.** A leading negation in the same clause suppresses the match outright rather
  than reducing its score.
- **No natural-language classification anywhere.** ADR-0013 makes free text unrepresentable in
  durable memory; this parser is the boundary that keeps it that way. It emits a closed union of
  four commands, never a topic, an intent, or a string.

Everything about it is a table plus a distance function, which makes it a Tier 1 test over a
fixture of transcripts including the adversarial ones above.

### 6.4 What the transcript does *not* gate

`packages/events` must not speak while the player is talking (dota2 §6.4). That gate runs on
**speech activity**, not on transcripts — `speech.resumed` / `speech.silence` from the analyser in
§3.2, available within a frame, versus a transcript that arrives after the utterance ends. Using
the transcript there would gate on information that arrives too late to be a gate.

---

## 7. Classes and methods

Signatures are the contract; bodies are step 7. Everything takes its collaborators by injection,
because that is what lets the whole component run against `FakeAudioDevice` and
`FakeRealtimeTransport` in Vitest with no window, no microphone and no network.

DOM types are named below but not in the scaffolded contract files: `packages/*` carry
`lib: ["ES2023"]`, so `MediaStreamTrack` and `AudioContext` cannot be named there yet (the same
constraint `apps/desktop` hit — overlay §7.2). The contract files declare the DOM-free majority
plus opaque handles; the DOM-typed constructors land with the voice window, when step 6 splits the
app into per-surface projects.

### 7.1 `packages/audio`

```ts
// level.ts — pure. Every function here is a Tier 1 test against known PCM.
export interface LevelSample {
  readonly rms: number;        // 0..1
  readonly peak: number;       // 0..1
  readonly at: MonoMs;
}

export function rms(frame: Float32Array): number;
export function peak(frame: Float32Array): number;
export function dbfs(amplitude: number): number;
export function isSilent(sample: LevelSample, floorDb: number): boolean;

/** One-pole envelope with distinct attack and release. Used for the output envelope, not for
 *  the chip's ballistics — that split is overlay §7.4. */
export function envelope(previous: number, target: number, opts: EnvelopeOptions): number;

export interface EnvelopeOptions {
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly frameMs: number;
}
```

```ts
// resample.ts — pure. §4.2.
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array;
export function floatToPcm16(input: Float32Array): Int16Array;   // little-endian, realtime §3
export function pcm16ToFloat(input: Int16Array): Float32Array;

/** A class, and only because fractional phase must survive across frames (§4.2). */
export interface StreamingResampler {
  push(frame: Float32Array): Float32Array;
  flush(): Float32Array;
  reset(): void;
}
export function createStreamingResampler(fromRate: number, toRate: number): StreamingResampler;
```

```ts
// device.ts
export interface AudioDeviceInfo {
  readonly id: DeviceId;
  readonly label: string;
  readonly kind: 'input' | 'output';
  readonly isDefault: boolean;
}

export interface CaptureRequest {
  readonly deviceId: DeviceId | null;          // null = system default
  readonly echoCancellation: boolean;          // never false in the product path (§3.4)
  readonly noiseSuppression: boolean;
  readonly autoGainControl: boolean;
}

export interface DeviceRegistry {
  list(): Promise<readonly AudioDeviceInfo[]>;
  permission(): Promise<MicPermission>;        // 'granted' | 'denied' | 'prompt'
  open(request: CaptureRequest): Promise<MicStream>;
  close(stream: MicStream): void;
  onChange(listener: () => void): Unsubscribe;
}
```

```ts
// capture.ts — the graph of §3.2.
export interface CaptureGraphOptions {
  readonly preRollMs: number;      // default 200 — §3.3, and permitted to be 0
  readonly gateRampMs: number;     // default 8 — a step is a click
  readonly levelIntervalMs: number;// default 33 (~30 Hz, overlay §5.5)
  readonly silenceFloorDb: number; // default -50, drives speech.silence
}

export interface CaptureGraph {
  readonly outbound: OutboundTrack;            // handed to the transport, never over IPC

  /** Synchronous, and on the trigger path: opens the gate over gateRampMs. */
  open(): void;
  close(): void;
  readonly isOpen: boolean;

  onLevel(listener: (sample: LevelSample) => void): Unsubscribe;
  /** Derived from the pre-gate analyser, so it is available whether or not the gate is open. */
  onSpeech(listener: (event: 'silence' | 'resumed') => void): Unsubscribe;

  /** Swap the microphone without renegotiating the peer connection (§3.5). */
  replaceStream(stream: MicStream): Promise<void>;
  dispose(): Promise<void>;
}
```

```ts
// playback.ts — §4.3.
export interface PlaybackReport {
  readonly responseId: ResponseId;
  readonly itemId: ItemId;
  readonly audibleMs: number;
  readonly interrupted: boolean;
}

export interface PlaybackTracker {
  beginResponse(responseId: ResponseId, itemId: ItemId): void;
  /** The number conversation.item.truncate needs. Valid mid-response. */
  audibleMs(): number;
  endResponse(interrupted: boolean): PlaybackReport;
  onLevel(listener: (sample: LevelSample) => void): Unsubscribe;
}
```

```ts
// earcons.ts, ducking.ts
export type EarconId = 'capture-start' | 'capture-end' | 'error';

export interface EarconPlayer {
  play(id: EarconId): void;      // fire-and-forget; never awaited on the trigger path
  setGainDb(db: number): void;   // default -18 (ui-design §7.1)
  setEnabled(on: boolean): void;
}

export interface Ducker {
  readonly available: boolean;   // false is legitimate; it must not claim what it did not do
  duck(amountDb: number, rampMs: number): Promise<void>;
  restore(rampMs: number): Promise<void>;
}
```

### 7.2 `packages/realtime`

```ts
// credentials.ts — main process.
export interface ClientSecret {
  readonly value: string;
  readonly expiresAt: MonoMs;
  readonly sessionId: SessionId;
}

export interface ClientSecretBroker {
  mint(config: RealtimeSessionConfig): Promise<ClientSecret>;
}

export interface ClientSecretBrokerDeps {
  /**
   * Injected by the composition root from @riki/config. This package never reads process.env.
   * An opaque `ApiKey` rather than a `string` (ADR-0022): the lint boundary stops the deliberate
   * leak, and this stops the accidental one — `JSON.stringify(deps)`, a key interpolated into an
   * error message, `console.log` of a config object. It renders as `[redacted]` through
   * `toString`, `toJSON` and `util.inspect`; `reveal()` is the single way out.
   */
  readonly apiKey: ApiKey;
  readonly safetyIdentifier: string;    // hashed install id, from main — research §6
  readonly fetch: FetchLike;
  readonly now: () => MonoMs;
}
```

```ts
// session-config.ts — §5.3. The only place a wire payload is constructed.
export interface RealtimeSessionConfig {
  readonly model: ModelId;
  readonly voice: VoiceName;
  readonly instructions: string;                 // the preamble, from @riki/context
  readonly tools: readonly ToolManifestEntry[];  // frozen for the session (ADR-0011)
  readonly turnDetection: TurnDetectionConfig;   // §5.4
  readonly noiseReduction: 'near_field' | 'far_field' | null;
  readonly transcription: TranscriptionConfig | null;
  readonly truncation: TruncationConfig;
}

export interface TurnDetectionConfig {
  readonly kind: 'server_vad' | 'semantic_vad' | 'none';
  readonly createResponse: false;                // literal: ADR-0017 — never true
  readonly interruptResponse: boolean;
  readonly silenceDurationMs: number;            // default 200 — on the release path (§5.4)
}

export function buildSessionUpdate(config: RealtimeSessionConfig): SessionUpdate;
/** Throws on a beta-shaped payload: a top-level `voice`, or a string audio format. */
export function assertGaShape(payload: unknown): asserts payload is SessionUpdate;
```

```ts
// transport.ts — §5.2.
export type TransportState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

export type TransportMedia =
  | { readonly kind: 'track'; readonly outbound: OutboundTrack;
      readonly onRemoteTrack: (track: RemoteTrack) => void }
  | { readonly kind: 'pcm'; readonly outbound: AsyncIterable<Int16Array>;
      readonly onOutputAudio: (chunk: Int16Array) => void };

export interface RealtimeTransport {
  readonly kind: 'webrtc' | 'websocket' | 'fake';
  connect(secret: ClientSecret, media: TransportMedia): Promise<void>;
  send(event: ClientEvent): void;
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
  onStateChange(listener: (state: TransportState) => void): Unsubscribe;
  close(reason: string): Promise<void>;
}
```

```ts
// turn.ts — §5.4, §5.5.
export type CaptureMode = 'push' | 'latch';
export type TurnEndReason = 'release' | 'latch-tap' | 'timeout' | 'cancel';

export interface TurnController {
  /** Opens the gate. Synchronous — nothing on the trigger path may await. */
  beginTurn(mode: CaptureMode, now: MonoMs): TurnId;

  /**
   * Closes the gate, waits for speech_stopped bounded by commitGraceMs, injects the turn's
   * snapshot, then creates the response (§5.4).
   */
  endTurn(turnId: TurnId, reason: TurnEndReason, context: TurnContext): Promise<void>;

  /** Barge-in. `at` is the moment the player interrupted, from the machine (overlay §4.5). */
  interrupt(at: MonoMs): Promise<void>;
  abort(): Promise<void>;

  /** The trigger policy's path: no capture, straight to a response (dota2 §6.4). */
  speakUnprompted(context: TurnContext, brief: UnpromptedBrief): Promise<void>;
}
```

```ts
// session.ts — the facade, and the handle the overlay's VoiceBridge attaches to.
export interface RealtimeSessionHandle {
  readonly sessionId: SessionId;
  onEvent(listener: (event: VoiceEvent) => void): Unsubscribe;
  interrupt(at: MonoMs): void;
  abort(): void;
  resolveConsent(promptId: string, granted: boolean): void;
}

export interface RealtimeSession extends RealtimeSessionHandle {
  readonly turns: TurnController;
  readonly window: ContextWindowExecutor;
  readonly cost: CostMeter;
  close(reason: string): Promise<void>;
}

export interface RealtimeSessionDeps {
  readonly transport: RealtimeTransport;
  readonly capture: CaptureGraph;
  readonly playback: PlaybackTracker;
  readonly tools: ToolCallPort;          // forwards to the pipeline in main
  readonly clock: Clock;
  readonly telemetry: VoiceTelemetry;
}

export function createRealtimeSession(
  deps: RealtimeSessionDeps,
  context: SessionContext,               // preamble + manifest, from @riki/context
  config: RealtimeSessionConfig,
): Promise<RealtimeSession>;
```

```ts
// types.ts — the vendor-free event stream. The overlay adapter's translation table (overlay §5.6)
// maps this onto MachineInput one-to-one, which is the point of it existing.
export type VoiceEvent =
  | { readonly kind: 'capture'; readonly event: 'opened' | 'firstAudio' | 'closed' }
  | { readonly kind: 'speech'; readonly event: 'silence' | 'resumed' }
  | { readonly kind: 'turn'; readonly turnId: TurnId;
      readonly event: 'submitted' | 'responseStarted' | 'responseEnded' }
  | { readonly kind: 'tool'; readonly event: 'started' | 'ended';
      readonly name: string; readonly callId: CallId }
  | { readonly kind: 'consent'; readonly event: 'requested' | 'resolved';
      readonly promptId: string }
  | { readonly kind: 'transcript'; readonly role: 'player' | 'agent';
      readonly turnId: TurnId; readonly text: string; readonly final: boolean }
  | { readonly kind: 'command'; readonly command: LocalCommand; readonly confidence: number }
  | { readonly kind: 'level'; readonly source: 'input' | 'output'; readonly value: number;
      readonly at: MonoMs }
  | { readonly kind: 'cost'; readonly snapshot: CostSnapshot }
  | { readonly kind: 'fault'; readonly fault: VoiceFault };

/** The kinds are exactly the overlay's FaultKind, minus the one its own timer produces. */
export type VoiceFaultKind =
  'mic-denied' | 'no-input-device' | 'offline' | 'auth' | 'session-lost';

export interface VoiceFault {
  readonly kind: VoiceFaultKind;
  readonly persistent: boolean;
  readonly message: string;
  readonly retryable: boolean;
}
```

```ts
// commands.ts — pure (§6.3).
export type LocalCommand =
  | { readonly kind: 'stop' }
  | { readonly kind: 'mute'; readonly minutes: number | null }
  | { readonly kind: 'quiet-mode'; readonly on: boolean }
  | { readonly kind: 'cancel' };

export interface CommandMatch {
  readonly command: LocalCommand;
  readonly confidence: number;      // 0..1, normalised edit distance over the matched clause
  readonly matchedPhrase: string;
}

export function parseLocalCommand(transcript: string, opts?: ParseOptions): CommandMatch | null;
```

```ts
// cost.ts — §5.8.
export interface CostSnapshot {
  readonly inputAudioTokens: number;
  readonly cachedInputTokens: number;
  readonly outputAudioTokens: number;
  readonly textTokens: number;
  readonly usd: number;
  readonly turns: number;
}

export interface CostMeter {
  record(usage: TokenUsage): void;
  snapshot(): CostSnapshot;
  /** Fires once per session. The player is told; new turns stop opening (§5.8). */
  onBudgetExceeded(listener: (snapshot: CostSnapshot) => void): Unsubscribe;
}
```

### 7.3 The composition root

`apps/desktop/src/main/voice/` wires it, and it is the only place all of these names appear
together: `packages/config` yields the key and the settings; `ClientSecretBroker` mints; the voice
window is created and handed the secret plus `SessionContext`; `VoiceBridge` (overlay §5.6)
attaches to the `RealtimeSessionHandle`; `ContextWindowPort` is bound to
`ContextWindowExecutor`. There is no `ToolCallPort` to bind: ADR-0023 removed it. None of those
packages import each other.

---

## 8. Integration

### 8.1 Every counterpart, in one table

| Counterpart | Direction | Carried by | What flows |
|---|---|---|---|
| `packages/config` | in | injected at construction | API key (main only), model, voice, transport, device, pre-roll, budgets |
| `packages/context` | in | `SessionContext` | Preamble and frozen tool manifest, at session open |
| `packages/context` | in | `TurnContext` | The rendered snapshot, per turn |
| `packages/context` | in | `WindowPlan` via `ContextWindowPort.apply` | What to drop and what replaces it |
| `packages/context` | out | `onDropped`, `usage`, transcripts | What was really dropped, real token usage, `player_said` / `agent_said` |
| `packages/events` | in | `speakUnprompted` | The decision to speak, with its brief |
| `apps/desktop` overlay | out | `VoiceEvent` → `VoiceBridge` | capture / speech / turn / tool / consent / level / fault |
| `apps/desktop` overlay | in | `VoiceCommand` → handle | interrupt, abort, consent |
| `apps/desktop` main | in | `ToolCallPort` results | Tool results and consent resolutions |
| `packages/telemetry` | out | `VoiceTelemetry` | Turn latencies, truncations, faults, cost. **Never** transcripts or the key |
| OpenAI | both | `RealtimeTransport` | The only external egress in this component |

### 8.2 One push-to-talk turn

```
key down (main, sync) ──► machine: armed ──► VoiceCommand? no: capture is ours
   t+0    CaptureGraph.open()                 gate ramps 8 ms; emits audio from t-200 ms
   t+0    EarconPlayer.play('capture-start')
   t+~5   VoiceEvent capture.opened           ──► machine (chip already visible: overlay §9.1)
   t+~40  first level above floor             ──► capture.firstAudio → chip Listening
key up
   t+0    CaptureGraph.close(); earcon capture-end
   t+0    ContextAssembler.openTurn()         <5 ms, in main
   t+≤400 input_audio_buffer.speech_stopped   bounded by commitGraceMs (§5.4)
   t+~1   conversation.item.create(snapshot)  the freshest possible state
   t+~1   response.create                     ──► VoiceEvent turn.submitted → chip Processing
   ...    remote track carries audio          ──► turn.responseStarted → chip Speaking, duck on
   ...    response.done                       ──► CostMeter.record; turn.responseEnded
```

### 8.3 A tool call inside that turn

```
data channel: response.function_call_arguments.done
   ──► ToolCallPort.dispatch(call)          ──► main: tool pipeline (agent-command §4)
        │                                         may raise ConsentRequest → machine → Confirming
        │◄── ToolResultMessage (always, within its deadline — that document's rule)
   ──► conversation.item.create(function_call_output) ; response.create
```

Two things this component owes that pipeline, both from realtime §11.6: forward the call promptly
and never drop it (a dropped call is a hung session, which is why `no-floating-promises` is an
error here), and never treat the *spoken* audio as evidence a tool ran — the model sometimes
narrates a call it did not make, and occasionally leaks call arguments into speech.

### 8.4 Latency budget

| Step | Budget | Whose |
|---|---|---|
| Key-down → gate open | ≤5 ms | Ours — synchronous, no device work, no await |
| Key-down → chip visible | ≤100 ms | Overlay's. We must not be on this path at all |
| Gate open → first audio transmitted | ~20 ms | Chromium (one Opus frame) |
| Pre-roll | +200 ms on every utterance, by design | Ours (§3.3) |
| Key-up → `response.create` | ≤ 405 ms | Ours: `speech_stopped` grace + snapshot injection |
| Release → first audio out | ≤1.5 s target | Shared; research §7 says plan for 1–1.5 s, not 190 ms |
| Level frame cadence | 30 Hz | Ours, coalesced (overlay §5.5) |

The one to watch is the third and fourth rows together: pre-roll and commit grace are both ours,
both settings, and both are pure latency. If the release→speaking budget is missed in real use,
they are the first two numbers to move — before anything about the model.

---

## 9. Failure modes

The cross-cutting principle from dota2 §9 holds here too: **degrade loudly to the developer,
quietly to the user, and never silently into wrongness.**

| Failure | Detection | Response |
|---|---|---|
| No API key | `packages/config` at startup | Voice never starts; tray and settings say so. The app boots. This is the mode CI and `pnpm dev:replay` run in (§7.1) |
| Mic permission denied | `open()` rejects | `mic-denied`, persistent — the chip stays in Error until resolved |
| No input device / device unplugged | device change with no inputs left | `no-input-device`, persistent. A swap that *does* find a device is not a fault (§3.5) |
| Mint fails 401 | broker | `auth`, persistent, names `RIKI_OPENAI_API_KEY`. Never retried in a loop |
| Mint fails 429 | broker | Backoff with jitter; `offline` after the third failure |
| SDP / ICE failure | connect timeout | One retry, then the configured fallback transport, then `session-lost` |
| Data channel closes mid-response | transport state | Truncate at `audibleMs`, end the turn as failed, rehydrate into a new session (§5.7) |
| Model interrupts itself | `speech_started` while our gate is closed | Ignore it, count it, and surface it in development. It means AEC is not working (§3.4) and it is the loop research §11.5 documents |
| Context exhausted before we compacted | `onDropped(..., 'api_truncation')` | Report to context; alert in telemetry. Context §6 treats a non-zero count as a bug |
| 60-minute cap approaching | elapsed | Rotate at 50 min (§5.7) |
| Cost budget exceeded | `CostMeter` | Say so once; stop opening turns; the session stays up so the player can still be told why |
| Ducking unsupported on this platform | `Ducker.available === false` | Say so in settings rather than showing a control that does nothing |

---

## 10. Privacy

The enumeration in dota2 §7 is the standard, and this component is where three of its rows are
actually enforced:

- ✅ **The player's own microphone, only while the gate is open.** The gate is the enforcement
  point and §11 asserts it: with the gate closed, the outbound track carries no signal.
- ❌ **Game voice chat is never captured.** There is no capture path for output devices anywhere in
  this design — `PlaybackTracker` analyses Riki's *own* remote track and nothing else. dota2 §7
  makes this a legal question, not an etiquette one, and the way to keep it settled is to have no
  code that could do it.
- ⚠️ **Transcripts exist and are the most sensitive thing here.** They live in the ledger, which
  is off by default for persistence (context §6.5), never reach `packages/telemetry` (redaction
  covers them alongside chat text and the key), and never reach durable memory at all (ADR-0013).
- ✅ **The API key is in one process and one module.** §5.1.

---

## 11. Testing

Every row here runs with no microphone, no network and no key (V7).

| Tier | Test | Guards |
|---|---|---|
| 1 | 48k→24k→48k round trip on a known tone; frequency within tolerance | The pitch-shift failure that is not an exception (realtime §3, §5.4) |
| 1 | `StreamingResampler` over 1,000 chunks: no drift, no discontinuity at boundaries | §4.2's phase bug |
| 1 | RMS, peak, dBFS, envelope against `FakeAudioDevice`'s known PCM | The chip's bars, and the silence detection the timeouts depend on |
| 1 | `parseLocalCommand` over a transcript fixture including "don't stop farming", "shuddup", "stop" | §6.3's false-positive rules |
| 1 | `CostMeter` arithmetic against the §5.8 worked example | That the cost lever stays a number and not a vibe |
| 2 | Golden snapshot of `buildSessionUpdate()` output | The beta/GA trap — a diff is how an SDK bump becomes visible (§5.3) |
| 2 | Golden of the client-event sequence for one PTT turn | Ordering: snapshot before `response.create`, commit grace honoured |
| 4 | Simulated barge-in: assert a truncate with a plausible `audio_end_ms` on the WS path, and exactly one truncation on the WebRTC path | §5.5, including the double-truncate mistake |
| 4 | Simulated 25-minute session against `FakeRealtimeTransport` | Retention fires; cache-busting truncations stay under threshold (realtime §5) |
| 4 | Mid-response disconnect | Rehydration, and that a lost session is a fault and not a hang |
| 4 | Gate closed → outbound frames are silent | The privacy claim in §10, as an assertion |
| 4 | `RIKI_OPENAI_API_KEY` unset | App boots, voice reports unavailable, `dev:replay` still runs |
| 5 | Key-down → chip visible ≤100 ms, with the voice window present | That we did not end up on the overlay's critical path |

Fixtures this component needs, all committed alongside the code that reads them: a happy PTT turn,
a barge-in, a tool call with a consent gate, a mid-response disconnect, a context-exhaustion
sequence, and a 25-minute session, under `fixtures/realtime/`. Tones and PCM are **generated in
the test**, deterministically — committing binary audio to check arithmetic would be a fixture
nobody can read in a diff.

What is not testable here, and gets a runbook instead: whether AEC survives the Web Audio graph
(§3.4), whether 200 ms of pre-roll is the right number (§3.3), and the real end-to-end latency on
our own audio path, which research §7 says explicitly is the number to measure rather than to
plan against.

---

## 12. What this needs from `packages/protocol`

**Landed** in `packages/protocol/src/schemas/voice.ts`, with the corpus in `fixtures/protocol/voice/` and a contract test that fails if a message type has no fixture. The table below is what was asked for; three rows changed on the way and the reasons are under it.

| Message | Direction | Payload |
|---|---|---|
| `voice.credential` | main → renderer | `ClientSecret` — value, expiry, session id |
| `voice.session.open` / `close` | main → renderer | `SessionContext` + `RealtimeSessionConfig` |
| `voice.turn.begin` / `end` | main → renderer | Capture mode, turn id, `TurnContext` |
| `voice.command` | main → renderer | `VoiceCommand` (interrupt / abort / consent) |
| `voice.window.apply` | main → renderer | `WindowPlan` |
| `voice.event` | renderer → main | `VoiceEvent` |
| `voice.tool.call` / `result` | both | `RawToolCall` / `ToolResultMessage` |

What changed against that table:

- **`voice.tool.call` / `result` are gone, and something like them is owed again.**
  [ADR-0023](../adr/0023-coaching-replaces-command-execution.md) deleted the pull model they
  belonged to; consent went with them, so `VoiceCommand` is `interrupt | abort`. ADR-0042 then
  reversed the tool decision, and T4 wired dispatch into the session behind a `ToolDispatcher` port
  — but **the port has no implementation on this side of the bridge**. The session runs in the voice
  window and the world model runs in main (ADR-0002, ADR-0015), so a real dispatcher needs a
  renderer→main *request* carrying a tool name and arguments and getting a JSON result back. That
  message does not exist in `schemas/voice.ts` and adding it is a protocol coordination event. Until
  it lands, `apps/desktop` injects no dispatcher, the session sends `tools: []`, and Riki answers
  from the injected snapshot alone — see `RealtimeSessionDeps.tools` and ADR-0049.
- **`voice.turn.speak` was added.** The proactive path is the *primary* one under ADR-0023 and it is
  not a turn begin/end pair — no capture, no gesture, straight to a response.
- **`voice.level.enable` was added.** Overlay §5.5 says level frames cross while the chip can show
  bars *and not otherwise*; without a message saying which, "not otherwise" has no producer and an
  idle Riki pays 30 IPC messages a second forever.

Two constraints the table did not anticipate, both recorded in the schema's header:

- **No `MonoMs` crosses.** Main and the renderer do not share a `performance.timeOrigin`, so an
  absolute uptime from one is meaningless to the other *and looks entirely plausible in a log*.
  `ClientSecret` carries `expiresInMs`; level frames are stamped by main on receipt.
- **Main allocates the turn id.** `CoachingAgent.beginPlayerTurn` must return one synchronously
  (the overlay's ≤100 ms budget), and an id allocated in the renderer could only come back
  asynchronously. `TurnController.beginTurn` takes it as an argument.

`WindowPlan` is schematised here rather than re-declared, as this section asked. The structural
mirrors in `packages/realtime` remain: that package is the renderer-side implementation and the
adapter at the bridge is where the two meet, which keeps `@riki/realtime` free of a zod dependency
on the hot path.

---

## 13. Open questions

1. **Does Chromium's echo cancellation survive the Web Audio graph in §3.2?** Measurable in an
   afternoon with a tone and an analyser. If it does not, pre-roll moves or goes. **Blocking for
   §3.3.**
2. **Is `input_audio_buffer.commit` honoured on the WebRTC path with VAD on?** If it is, the
   commit grace in §5.4 disappears and every turn gets up to 400 ms faster. If it is not, the
   400 ms is structural and `silence_duration_ms` is the only lever.
3. **Does `turn_detection: 'none'` really disable server-side barge-in truncation?** ADR-0017
   assumes yes from the shape of the API rather than from a documented statement. If it is wrong,
   the ADR is a preference rather than a necessity — worth knowing which.
4. **Is 200 ms of pre-roll worth 200 ms of latency?** Needs real users, not a measurement.
5. **How much of a match is actually cached?** §5.8 says the cached fraction is the only cost
   number that matters, and it is the one number we cannot estimate from outside a real session.
6. **Which transcription model?** Hero names, item names and Dota jargon are exactly the
   vocabulary a general ASR model is worst at, and §6.3's matching is downstream of it.
7. **What happens to a latched session when the player alt-tabs?** The mic stays open with the
   player's attention elsewhere. Probably an auto-close on focus loss; it is a product call.

---

## 14. Build order

Front-loaded so that everything testable lands before anything that needs a window.

| # | Step | Needs |
|---|---|---|
| ~~1~~ | ~~`level.ts`, `resample.ts`, `commands.ts`, `cost.ts` — the pure half~~ **Landed** | Nothing. No Electron, no fakes |
| ~~2~~ | ~~`session-config.ts` + `assertGaShape` + the golden snapshot~~ **Landed** | Nothing |
| ~~3~~ | ~~`FakeRealtimeTransport` + the `fixtures/realtime/` corpus~~ **Landed** — all six of `REQUIRED_FIXTURES`, replayed through a real session in `test/fixtures.test.ts` | Step 2 |
| ~~4~~ | ~~`turn.ts`, `window.ts` against the fake~~ **Landed**. Retention *policy* is not here: ADR-0012 put it in `packages/context`, and this is the executor half | Steps 2–3 |
| ~~5~~ | ~~`credentials.ts` in main, with a stubbed `fetch`~~ **Landed** — reachable early, since a stubbed `fetch` needs no `packages/config` | — |
| ~~6~~ | ~~`capture.ts`, `playback.ts`, `earcons.ts`~~ **Landed except `EarconPlayer`**, which needs a real `AudioContext`. `CaptureGraph` and `DeviceRegistry` build over injected ports, so neither waits on the window | — |
| 7 | The composition root, and `pnpm dev:replay` driving a full turn through the fakes | Everything above, plus the overlay's step 6 |
| 8 | `ducking.ts` implementations, per platform | Step 7, and only where a platform has one — [ADR-0020](../adr/0020-ducking-is-a-no-op-by-default.md) |

Steps 1–6 are the majority of the logic and none of them needs a microphone, which was the point.

---

## 15. Where each section lands

| Section | File |
|---|---|
| §3.2, §3.3, §3.5 | `packages/audio/src/capture.ts` |
| §3.1, §3.5 | `packages/audio/src/device.ts` |
| §4.3 | `packages/audio/src/playback.ts` |
| §4.4 | `packages/audio/src/earcons.ts`, `packages/audio/src/ducking.ts` |
| §4.2 | `packages/audio/src/resample.ts` |
| level maths | `packages/audio/src/level.ts` |
| §5.1 | `packages/realtime/src/credentials.ts` |
| §5.2 | `packages/realtime/src/transport.ts`, `wire.ts` |
| §5.3 | `packages/realtime/src/session-config.ts` |
| §5.4, §5.5 | `packages/realtime/src/turn.ts` |
| §5.6 | `packages/realtime/src/window.ts` |
| §5.7 | `packages/realtime/src/session.ts` |
| §5.8 | `packages/realtime/src/cost.ts` |
| §6.1 | `packages/realtime/src/transcript.ts` |
| §6.3 | `packages/realtime/src/commands.ts` |
| §7.3 | `apps/desktop/src/main/voice/` (does not exist yet — §2.2 has no row for it) |

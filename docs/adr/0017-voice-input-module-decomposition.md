# ADR-0017: The voice input component's module and class decomposition

**Status:** Accepted
**Date:** 2026-08-01

## Context

Every other component in this repo got a design document before its implementation —
`overlay-architecture.md`, `state-capture-architecture.md`,
`agent-command-execution-architecture.md`, `context-and-memory-architecture.md`. **The voice input
component never got one**, and the task that produced this ADR was dispatched to implement from an
approved design that does not exist and never has.

The decision taken instead was to implement directly against what *is* already settled — which
turned out to be most of it:

| Already decided | Where |
| --- | --- |
| WebRTC is the transport | [ADR-0002](0002-webrtc-transport.md) |
| Push-to-talk is the default, so `turn_detection: null` | [ADR-0004](0004-push-to-talk-default.md) |
| A hidden voice window owns the mic and the peer connection | [ADR-0010](0010-dedicated-voice-window.md) |
| The API key is injected, read only by `packages/config` | REPO_SKELETON §7.1 |
| The ports the overlay expects — `VoiceCommandSink`, `AudioEffectSink`, `LevelFrame` | overlay-architecture §5, §8 |
| Where the tool-call seam falls | agent-command-execution §1.1, §2 |
| Five named guarding tests | REPO_SKELETON §5.4 |

This ADR records the decomposition that filled the gap, so the next agent has the *why* that a
design document would normally carry. It is deliberately an ADR and not a new design doc: the
code exists now, and a document describing code is a thing that goes stale.

## Decision

Two packages, split on **what fails when it is wrong** rather than on subject matter.

```
@riki/audio — signal. No wire vocabulary, no session, no globals.
  pcm/codec          float32 ↔ PCM16 LE ↔ base64
  resample/          windowed-sinc, arbitrary ratio, streaming
  levels/            rms · EnvelopeFollower · LevelPump (30 Hz) · SilenceDetector
  earcons/           the three tones from ui-design §7.1, synthesised
  ducking/           capability table + the no-op default (ADR-0016)
  capture/           ports (DOM-free) + AudioCaptureStream

@riki/realtime — the session. Depends on @riki/audio for the codec and the rate.
  protocol/          ga-schema (the ONLY builder of session.update) · server-events (the only reader)
  transport/         RealtimeTransport port
  turn/              PlaybackTracker (barge-in) · ToolCallAccumulator
  transcript/        TranscriptAssembler
  retention/         RetentionPolicy
  cost/              CostMeter
  auth/              ApiKey (self-redacting) · EphemeralSecretMinter
  session/           RealtimeSession — the only object anyone outside holds
```

Four rules hold across both:

1. **Nothing reads a global.** No `process`, `navigator`, `AudioContext`, `fetch` or clock. Time,
   rates, devices, transports and credentials all arrive by injection. This is what makes the
   whole component testable under REPO_SKELETON §5.2 with no microphone, no socket and no key.
2. **The wire vocabulary is confined to `protocol/`.** Nothing else in the repo may contain the
   string `response.output_audio.delta`. §3 of the research note documents that these names have
   already changed once, silently.
3. **Events are named for `MachineInput`**, not for the wire, so the `VoiceBridge` the wiring pass
   writes is a table with no logic in it (overlay-architecture §5.6).
4. **Unknown server events are ignored; malformed known ones are faults.** The API gains events
   without a version bump, and a session that dies because OpenAI shipped a notification is worse
   than one that ignores it.

### Three decisions inside that are not obvious

**Barge-in truncation is manual on every transport, including WebRTC.** Research §4 says WebRTC
handles barge-in server-side and there is "nothing to do" — and that is true only when server VAD
is running. ADR-0004 sets `turn_detection: null`, so there is no VAD, so the server cannot detect
an interruption that only Riki's hotkey knows about. `PlaybackTracker` therefore exists on the
default transport, not just the fallback one.

The same interaction bites a second time and harder: on WebRTC the audio rides the media track, so
`response.output_audio.delta` **never arrives**. A tracker keyed only off audio deltas passes every
websocket test and then silently never truncates in production. Playback is therefore begun by
either an audio delta or an assistant transcript delta, whichever comes first.

**Our retention ratio is 0.6, not §5's 0.8.** That 0.8 is the *API's* `retention_ratio`, whose
trigger is the window actually being full — so it leaves 20 % of headroom. Our policy triggers at
90 %, so copying 0.8 would leave 10 % and compact twice as often as OpenAI's own advice implies.
At one turn per 20 s carrying ~500 tokens, 0.8 gives ~10 compactions per 45-minute match against
0.6's ~5, and each compaction re-pays full price for everything retained against an 80× cached
discount. The two ratios are different knobs and the session does not forward one into the other.

**`ApiKey` is a class, not a string.** It stringifies, `JSON.stringify`s and `util.inspect`s to
`[redacted]`. The lint boundary in §6.2 stops this package *reading* the environment; nothing stops
a key reaching a log through a template literal in an error message, which is the realistic
accident.

## Consequences

- The five §5.4 guarding tests exist and pass: GA-schema snapshot, resampling round-trip, barge-in
  truncate, 25-minute retention, key-never-leaks. Each one caught something or pinned something.
- Writing the tests found three real bugs before any wiring: `setEnabled(false)` mid-duck left the
  game permanently attenuated; the retention policy compacted every ~3 minutes; and the WebRTC
  barge-in failure above. All three are silent in production.
- `@riki/realtime` depends on `@riki/audio`. One direction only, and it buys a single definition
  of the 24 kHz rate and of the PCM encoder — two things that must agree and would otherwise be
  duplicated.
- **Nothing is wired.** No Electron, no `getUserMedia`, no `RTCPeerConnection`, no
  `VoiceBridge`, no `packages/config` (still a stub). The WebRTC transport is a port with a fake
  behind it; the real adapter is the wiring pass's job, and it is the part with no test coverage
  that REPO_SKELETON §5.2 permits.
- ADR-0010 moves from Proposed to Accepted. It said the agent who builds `packages/realtime` owns
  that decision; nothing in building it argued for folding the voice window into the overlay.

## Alternatives rejected

- **Write the missing design document first.** It would have been the house pattern, and it was
  offered. The decision was to implement against the already-settled constraints and record the
  decomposition here, because the constraint set turned out to be nearly complete and a document
  written alongside code that exists is a document that drifts from it.
- **One `@riki/voice` package.** The DSP is pure, synchronous and CPU-bound; the session is
  asynchronous, stateful and I/O-bound. They fail differently, they are tested differently, and
  §2.2's ownership map already splits them.
- **Put the tool-argument JSON parse in `packages/realtime`.** agent-command-execution §1.1 draws
  the line explicitly, and parsing here would turn a malformed-argument failure — which has a
  defined home in that component's taxonomy — into a wire fault that kills the session.
- **Use the `openai-agents-js` SDK.** It is the natural fit (research §8) and it is the subject of
  the one bug the research note names by number — openai-agents-js#495, GA settings silently
  discarded. The wire surface we need is small, and a hand-written `session.update` is one that
  can be snapshot-tested.
- **Ship earcons as `.wav` resources.** Synthesising them makes the frequencies assertable, adds
  no binary to git, and renders at whatever rate the device is running.

See [audio-ducking-platform-support.md](../research/audio-ducking-platform-support.md),
[openai-realtime-research.md](../research/openai-realtime-research.md) §3–§5 and §10, and
REPO_SKELETON.md §5.4.

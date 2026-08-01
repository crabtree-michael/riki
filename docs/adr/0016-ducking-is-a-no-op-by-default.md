# ADR-0016: Ducking is a no-op by default, and that is a correct sink

**Status:** Accepted
**Date:** 2026-08-01

## Context

[`ui-design.md`](../design/ui-design.md) §7.2 specifies ducking other application audio by −12 dB
with a 120 ms ramp in and 250 ms out while Riki speaks, and hedges it: "per-application **where
the OS allows it**". That hedge was never cashed out, and
[`overlay-architecture.md`](../design/overlay-architecture.md) §8 built on it — ducking is an
effect of Speaking, emitted unconditionally by the interaction machine, with `AudioEffectSink`
honouring the user's preference.

Cashing it out gives an uncomfortable answer. The evidence is in
[audio-ducking-platform-support.md](../research/audio-ducking-platform-support.md):

| Platform | Public API to duck *other* apps? | Honours §7.2's numbers? |
| --- | --- | --- |
| **macOS** (primary, [ADR-0015](0015-macos-is-the-primary-target.md)) | **No** | — |
| Windows | Indirect — a WASAPI communications-role stream; the OS picks depth and ramp | No |
| Linux | Yes, per-stream through PipeWire/PulseAudio | Yes |

On macOS `AVAudioSession.CategoryOptions.duckOthers` is `API_UNAVAILABLE(macos)`, Core Audio
exposes only the default output device and our own stream, and every third-party tool that does
this (SoundSource, Audio Hijack, Background Music) installs an audio HAL plug-in — a privileged
system extension that owns the machine's default output device.

## Decision

**Ducking is unavailable on macOS, and the no-op path is the default rather than the exception.**
A `DuckingController` with no usable backend is a *correct* controller: it accepts every `duck()`
call, applies nothing, raises no fault, logs nothing, and retries nothing. It reports what it
actually got — `{ applied: false, availability }` — the way `OverlayWindowController.
setContentProtection` already does for the analogous non-portable case
(overlay-architecture.md §3.1).

Riki does **not** install an audio driver or system extension to work around this.

Unrecognised platforms get the macOS answer, not an optimistic one.

## Consequences

- **overlay-architecture.md §8's shape survives intact, and is vindicated.** The machine emits
  `duck` without branching on preference or platform; all the judgement lives in the sink. Had
  the machine branched, this decision would have been a change to the state machine.
- **ui-design.md §11's "game ducking on/off + depth" row must be absent or disabled on macOS**,
  with `capability.reason` as the explanation. A control that is present and inert is worse than
  one honestly missing.
- **ui-design.md §7.2's rationale becomes a live product risk.** Its argument is that "without
  ducking, TTS is unintelligible over combat audio and the player will just stop using the
  feature." If that is true, it is now true for most users, and it has to be answered another way
  — output-side compression on Riki's own TTS is the obvious mitigation and is fully under our
  control on every platform. **This is not solved by this ADR and needs a listening test.**
- Windows ducking is *not implemented* by this change. The capability table records that it
  exists and that we cannot set its parameters; whether the comms-role coupling is worth
  implementing at all is left open, because one predictable no-op everywhere may be better than
  one platform behaving differently in a way settings cannot describe.
- The −12 dB / 120 ms / 250 ms constants stay in the code. They are honoured where
  `honoursRequestedDepth` is true, and they document the intent everywhere else.

## Alternatives rejected

- **Ship an audio HAL plug-in / virtual output device.** It is how the third-party tools do it,
  and it is disqualified on its own merits: a privileged install and a user-approved system
  extension, inserting Riki into the audio path of a competitive game, for a −12 dB dip. It also
  sits badly beside [ADR-0003](0003-read-only-observation-only.md)'s posture of not modifying the
  player's system.
- **Lower the system output volume instead.** Attenuates everything including Riki's own TTS, is
  globally visible to the user, and leaves the machine in a changed state if Riki crashes
  mid-duck.
- **Treat the macOS path as a degraded mode that raises a fault or logs a warning.** Ducking
  being unavailable is the *normal* case on two of three platforms. Surfacing it as a fault would
  put an Error chip on screen mid-match for a feature that was never going to work.
- **Pause game audio instead of ducking.** Rejected already by the `voice-realtime` skill and
  ui-design §7.2, and it needs the same absent API.

# ADR-0020: Ducking is a no-op by default, and that is a correct implementation

**Status:** Accepted
**Date:** 2026-08-01

## Context

[`voice-input-architecture.md`](../design/voice-input-architecture.md) §4.4 declares a `Ducker`
interface with a platform-dependent `available`, and flags the question **Verify before building**:
ducking another application's audio is a Windows-shaped capability, macOS is the primary target
(ui-design A3), and the likely honest answer is `available === false`.

That has now been established rather than guessed —
[audio-ducking-platform-support.md](../research/audio-ducking-platform-support.md):

| Platform | Public API to duck *other* apps? | Honours §7.2's −12 dB / 120 / 250 ms? |
| --- | --- | --- |
| **macOS** (primary) | **No** | — |
| Windows (later) | Indirect: a WASAPI communications-role stream; the OS picks depth and ramp | No |
| Linux (dev) | Yes, per-stream via PipeWire/PulseAudio | Yes |

On macOS `AVAudioSession.CategoryOptions.duckOthers` carries `API_UNAVAILABLE(macos)`, Core Audio
exposes only the default output device and our own stream, and every third-party tool that manages
per-application volume (SoundSource, Audio Hijack, Background Music) installs an audio HAL plug-in
— a privileged system extension owning the machine's default output device.

## Decision

**`createNoopDucker()` is the default implementation, not a fallback.** A `Ducker` reporting
`available: false` is a *correct* `Ducker`: it accepts every call, attenuates nothing, raises no
fault, logs nothing, and retries nothing. Settings shows the control as unavailable with a reason
rather than showing one that does nothing.

Riki does **not** install an audio driver or system extension to work around this. Unrecognised
platforms get the macOS answer rather than an optimistic one.

Windows ducking is **not implemented** by this decision. The capability is recorded; whether the
comms-role coupling is worth building is left open, because one predictable no-op everywhere may be
better than one platform behaving differently in a way settings cannot describe.

## Consequences

- §4.4's design survives untouched and is vindicated — `available` plus a no-op that "reports
  itself as unavailable rather than silently pretending" is exactly the shape this needed. Had the
  overlay's machine branched on ducking availability (overlay §8 explicitly does not), this would
  have been a state-machine change instead.
- **ui-design §11's "game ducking on/off + depth" row is absent or disabled on macOS.**
- **The no-op path must stay silent.** Riki speaking over un-ducked game audio is the normal case
  for most users; a fault there would put an Error chip on screen mid-match for a feature that was
  never going to work.
- The −12 dB / 120 ms / 250 ms constants stay. They are honoured on Linux and document intent
  elsewhere.
- **ui-design §7.2's rationale becomes a live product risk.** Its argument is that "without
  ducking, TTS is unintelligible over combat audio and the player will just stop using the
  feature." That risk is now unmitigated for most users. Output-side compression on Riki's own TTS
  is the obvious answer and is fully under our control; whether it suffices is a listening test —
  open question 17 in [docs/README.md](../README.md). **This ADR does not solve it.**

## Alternatives rejected

- **Ship an audio HAL plug-in / virtual output device.** How the third-party tools do it, and
  disqualified on its merits: a privileged install and a user-approved system extension, inserting
  Riki into the audio path of a competitive game, for a −12 dB dip. It also sits badly beside
  [ADR-0003](0003-read-only-observation-only.md).
- **Lower the system output volume.** Attenuates everything including Riki's own TTS, is globally
  visible, and leaves the machine changed if Riki crashes mid-duck.
- **Treat the macOS path as a degraded mode that raises a fault or logs.** Ducking being
  unavailable is the *normal* case on the primary platform, not an error.
- **Block on implementing Windows ducking first** so the feature exists somewhere. It would make
  the least-used target the only one with the behaviour, and the design would be shaped by a
  platform most users are not on.

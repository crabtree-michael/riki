# Per-application audio ducking — what each platform actually allows

**Researched:** 2026-08-01
**Status:** Research only. Records a platform capability, not a decision. The decision it
forces belongs in an ADR alongside the voice component's architecture.

> **Why this exists:** [`ui-design.md`](../design/ui-design.md) §7.2 specifies ducking other
> application audio by −12 dB while Riki speaks, and hedges it with "per-application **where the
> OS allows it**". That hedge was never cashed out. This note cashes it out, because the answer
> changes what `AudioEffectSink.duck()` can honestly promise on each platform.

---

## 0. Assumptions

| # | Assumption | Affects |
|---|---|---|
| A1 | Riki ducks **other applications** (Dota 2), not its own output. Ducking your own stream is trivial everywhere and is not what §7.2 asks for. | everything below |
| A2 | Riki ships as a normal user-space app with no installer-privileged component, no kernel extension, and no audio driver. | ⚑ §3 — the macOS workarounds all violate this |
| A3 | "Ducking" means a temporary, ramped attenuation that restores itself, not a persistent volume change the user has to undo. | §4 |

---

## 1. Summary

| Platform | Public API to duck *other* apps? | Mechanism | Verdict |
|---|---|---|---|
| **macOS** | **No** | — | **No-op.** Report unavailable; do not pretend. |
| **Windows** | Partial, indirect | WASAPI communications-role stream + system ducking preference | Works, but the OS owns the depth and the ramp — not −12 dB/120 ms |
| **Linux (PipeWire/PulseAudio)** | Yes | `module-role-ducking` / per-stream volume on another client's sink input | Full control, but depends on the user's audio server config |

The `−12 dB, 120 ms in, 250 ms out` figures in ui-design §7.2 are **only achievable on Linux**.
Windows gives ducking with OS-chosen parameters; macOS gives nothing.

---

## 2. macOS — no public API

This is the finding that matters, since it is the one that removes a feature rather than
degrading it.

**There is no public macOS API by which one application can attenuate another application's
audio.** Three routes get proposed and all three fail:

1. **`AVAudioSession.CategoryOptions.duckOthers`** — this is the API everyone reaches for, and it
   is the one modelled on iOS. It is declared `API_UNAVAILABLE(macos)`. `AVAudioSession` itself
   gained a nominal macOS presence, but the category-options surface — `duckOthers` included — is
   not part of it. Code written against it does not compile on macOS; it does not silently no-op,
   which is at least a merciful failure mode.
2. **Core Audio / HAL** — exposes the *default output device's* volume and your own app's stream
   volume. There is no public property for another process's stream volume. The per-app volume
   sliders that Core Audio appears to imply are not reachable from outside the owning process.
3. **System output volume** — technically reachable, and wrong under A3: it attenuates
   *everything* including Riki's own TTS, is globally visible to the user, and leaves the machine
   in a changed state if Riki crashes mid-duck.

**How the apps that do this actually do it.** SoundSource, Audio Hijack (both Rogue Amoeba) and
the open-source Background Music all install an **audio HAL plug-in / virtual output driver** —
they insert themselves into the audio graph as a device, so every app's audio flows through them
and per-app attenuation becomes possible. That requires a privileged install, a user-approved
system extension, and ownership of the machine's default output device.

That is disqualified by A2, and it should stay disqualified on its own merits: Riki would be
inserting itself into the audio path of a competitive game, which is a large reliability and
support surface for a −12 dB dip, and it sits uncomfortably beside
[ADR-0003](../adr/0003-read-only-observation-only.md)'s posture of not modifying the player's
system.

**Conclusion: on macOS, ducking is unavailable.** Not "degraded", not "best-effort" —
unavailable.

## 3. Windows — ducking exists, but you do not control it

Windows does duck, via a mechanism designed for softphones: an app opens a WASAPI stream with the
**communications** role, and the system attenuates other streams for its duration.
`IAudioSessionControl2::SetDuckingPreference` lets an app opt out of the default behaviour.

Two consequences worth stating before anyone budgets for it:

- **The OS owns the depth and the ramp.** The attenuation applied is a system value, not −12 dB,
  and the ramp is not 120/250 ms. ui-design §7.2's numbers are not implementable here either;
  they become "whatever Windows does".
- **It is a side effect of opening a comms stream**, not a callable duck/unduck. Ducking is
  therefore coupled to the lifetime of an audio stream Riki holds, which is a coarser handle than
  "while Riki speaks".

Per-app volume proper (`ISimpleAudioVolume`) applies to your **own** session only, the same
limitation as macOS.

## 4. Linux — the only platform that can honour the spec

PipeWire and PulseAudio both expose other clients' streams as first-class objects with
independently settable volumes, and PulseAudio ships `module-role-ducking` specifically for this.
Depth and ramp are entirely ours. The caveat is configuration: the module may not be loaded, and
role metadata depends on the game setting it.

---

## 5. What this means for the implementation

`AudioEffectSink.duck(on: boolean)` is specified in
[`overlay-architecture.md`](../design/overlay-architecture.md) §8 as being emitted
*unconditionally* by the interaction machine, with the sink honouring the user's preference. That
shape survives this finding intact and is the reason it is the right shape — the machine does not
branch on platform capability any more than it branches on the preference.

What changes is the sink's contract:

- **The no-op path is the default, not the exception.** A sink that cannot duck is a correct sink,
  not a degraded one. It should not log an error, retry, or surface a fault — Riki speaking over
  un-ducked game audio is the normal case on two of three platforms.
- **`duck()` should report what it actually got**, the way
  `OverlayWindowController.setContentProtection` already does for the analogous non-portable case
  (overlay-architecture.md §3.1: "the setting must report what it actually is"). A boolean return
  or a small result type lets settings tell the truth.
- **The settings UI must not offer a control that does nothing.** ui-design.md §11 lists
  "game ducking on/off + depth" under Audio. On macOS that row should be absent or disabled with a
  reason, not present and inert.
- **ui-design §7.2's rationale is now a risk, not a solved problem.** The doc's argument is that
  "without ducking, TTS is unintelligible over combat audio and the player will just stop using
  the feature." If ducking is unavailable on the primary platform, that risk is live and has to be
  answered another way — louder/compressed TTS, a shorter speaking style, or accepting that the
  player turns game volume down themselves.

That last point is a product question, not an engineering one, and it should be raised rather than
absorbed silently.

---

## 6. Open questions

- **Does TTS intelligibility over un-ducked Dota audio actually hold up?** This is now load-bearing
  and is a listening test, not a spike. It is the real question §7.2 was avoiding.
- **Is output-side compression/limiting on Riki's own TTS a sufficient substitute** for ducking?
  It is fully under our control on every platform, and it is the obvious mitigation.
- **Is the Windows comms-role ducking worth implementing at all**, given it delivers unspecified
  parameters through a coupling to stream lifetime? A single no-op sink everywhere is simpler and
  more predictable than one platform behaving differently in a way we cannot describe in settings.

---

## Sources

- [`duckOthers` — Apple Developer Documentation](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/duckothers) · [`AVAudioSession`](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [AVFAudio macOS binding surface (`API_UNAVAILABLE(macos)` annotations)](https://github.com/dotnet/macios/wiki/AVFAudio-macOS-xcode26.0-b1) — cross-check that the option is absent on macOS specifically
- [Core Audio — overview](https://en.wikipedia.org/wiki/Core_Audio)
- [Background Music](https://github.com/kyleneideck/BackgroundMusic) — open-source per-app volume on macOS, implemented as a virtual audio device; the reference for what the workaround costs
- [How to control individual application volume on Mac](https://appletoolbox.com/how-to-control-individual-application-volume-on-mac/) — survey of the third-party tools and their driver-based approach
- `IAudioSessionControl2::SetDuckingPreference`, WASAPI communications-role ducking — Microsoft Learn
- PulseAudio `module-role-ducking`; PipeWire per-node volume

# Per-application audio ducking — what each platform actually allows

**Researched:** 2026-08-01
**Status:** Research. Answers the **Verify before building** flag in
[`voice-input-architecture.md`](../design/voice-input-architecture.md) §4.4. The decision it forces
is [ADR-0020](../adr/0020-ducking-is-a-no-op-by-default.md).

> §4.4 predicted the answer — "the likely honest answer on the primary platform is
> `available === false`" — and asked for it to be established before §7.2's ramp figures were
> implemented. It holds. This note is the evidence, so the next agent does not re-derive it from
> the shape of the API.

---

## 0. Assumptions

| # | Assumption | Affects |
|---|---|---|
| A1 | We duck **other applications** (Dota 2), not our own output. Ducking your own stream is trivial everywhere and is not what ui-design §7.2 asks for. | everything below |
| A2 | Riki ships as a normal user-space app: no installer-privileged component, no kernel extension, no audio driver. | ⚑ §2 — every macOS workaround violates this |
| A3 | "Ducking" is a temporary, ramped attenuation that restores itself, not a persistent volume change the user has to undo. | §2.3 |

---

## 1. Summary

| Platform | Public API to duck *other* apps? | Mechanism | `Ducker.available` |
|---|---|---|---|
| **macOS** (primary) | **No** | — | **`false`** |
| Windows (later target) | Indirect | WASAPI communications-role stream; the OS picks depth and ramp | `true`, but see §3 |
| Linux (dev platform) | Yes | `module-role-ducking` / per-stream volume via PipeWire or PulseAudio | `true` |

**ui-design §7.2's `−12 dB / 120 ms / 250 ms` is achievable on Linux only.** Windows ducks on its
own terms; macOS does not duck at all. So the figures describe intent everywhere and behaviour in
one place, and §4.4's guess that this is "a Windows-shaped capability" is right — except that even
Windows does not let us pick the shape.

## 2. macOS — no public API

The finding that matters, because it removes the feature rather than degrading it.

**There is no public macOS API by which one application attenuates another's audio.** Three routes
get proposed; all three fail:

1. **`AVAudioSession.CategoryOptions.duckOthers`** — the API everyone reaches for, and the one this
   feature was modelled on. It is declared `API_UNAVAILABLE(macos)`. `AVAudioSession` gained a
   nominal macOS presence, but the category-options surface is not part of it. Code written against
   it does not compile on macOS — a merciful failure mode, and the reason this was cheap to settle.
2. **Core Audio / HAL** — exposes the *default output device's* volume and our own stream's volume.
   There is no public property for another process's stream volume. §4.4 already says this; it is
   correct.
3. **System output volume** — reachable, and wrong under A3. It attenuates everything including
   Riki's own TTS, is globally visible, and leaves the machine changed if Riki crashes mid-duck.

**How the apps that do this actually do it.** SoundSource and Audio Hijack (Rogue Amoeba) and the
open-source Background Music all install an **audio HAL plug-in / virtual output driver**: they
insert themselves into the audio graph as a device, so every application's audio flows through them
and per-app attenuation becomes possible. That needs a privileged install, a user-approved system
extension, and ownership of the machine's default output device.

Disqualified by A2, and it should stay disqualified on its merits: inserting Riki into the audio
path of a competitive game is a large reliability and support surface for a −12 dB dip, and it sits
badly beside [ADR-0003](../adr/0003-read-only-observation-only.md)'s posture of not modifying the
player's system.

## 3. Windows — ducking exists, but you do not control it

Windows ducks through a mechanism designed for softphones: an application opens a WASAPI stream
with the **communications** role and the system attenuates other streams for its duration.
`IAudioSessionControl2::SetDuckingPreference` opts out of the default behaviour.

Two consequences worth recording before anyone budgets for it:

- **The OS owns the depth and the ramp.** The attenuation is a system value, not −12 dB, and the
  ramp is not 120/250 ms.
- **It is a side effect of holding a comms stream**, not a callable duck/restore. Ducking would be
  coupled to the lifetime of an audio stream Riki holds, which is coarser than "while Riki speaks"
  and does not map cleanly onto `Ducker.duck()` / `Ducker.restore()`.

Per-application volume proper (`ISimpleAudioVolume`) applies to your **own** session only — the
same limitation as macOS.

## 4. Linux — the only platform that can honour the spec

PipeWire and PulseAudio expose other clients' streams as first-class objects with independently
settable volumes, and PulseAudio ships `module-role-ducking` for exactly this. Depth and ramp are
ours. The caveat is configuration: the module may not be loaded, and role metadata depends on the
game setting it.

---

## 5. What this changes

The `Ducker` interface in `packages/audio/src/ducking.ts` already has the right shape —
`available` plus a no-op implementation that "reports itself as unavailable rather than silently
pretending" is precisely what this finding needs. Three things follow:

- **`createNoopDucker()` is the default path on the primary platform**, not a fallback. §4.4
  anticipated this ("the no-op path is the *default* path and deserves the better error copy").
- **The no-op must be silent.** No fault, no log, no retry. Riki speaking over un-ducked game audio
  is the normal case for most users, and surfacing it would put an Error chip on screen mid-match
  for a feature that was never going to work.
- **ui-design §11's "game ducking on/off + depth" row must be absent or disabled on macOS.** A
  control that is present and inert is worse than one honestly missing.

## 6. The open question this leaves

**ui-design §7.2's rationale is now a live risk rather than a solved problem.** Its argument for
ducking is that "without ducking, TTS is unintelligible over combat audio and the player will just
stop using the feature." If that is true, it is true for most users, and it needs another answer.

The obvious mitigation is output-side compression or limiting on Riki's own TTS: fully under our
control on every platform, no OS cooperation, and it does not touch the game's audio at all. That
is engineering. Whether it is *sufficient* is a listening test, not a spike — recorded as open
question 17 in [docs/README.md](../README.md).

---

## Sources

- [`duckOthers` — Apple Developer Documentation](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/duckothers) · [`AVAudioSession`](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [AVFAudio macOS binding surface](https://github.com/dotnet/macios/wiki/AVFAudio-macOS-xcode26.0-b1) — cross-check that the option carries `API_UNAVAILABLE(macos)`
- [Core Audio — overview](https://en.wikipedia.org/wiki/Core_Audio)
- [Background Music](https://github.com/kyleneideck/BackgroundMusic) — open-source per-app volume on macOS via a virtual audio device; the reference for what the workaround costs
- [Controlling individual application volume on Mac](https://appletoolbox.com/how-to-control-individual-application-volume-on-mac/) — survey of the third-party tools and their driver-based approach
- `IAudioSessionControl2::SetDuckingPreference` and WASAPI communications-role ducking — Microsoft Learn
- PulseAudio `module-role-ducking`; PipeWire per-node volume

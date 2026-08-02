# ADR-0030: The capture seam returns cropped regions, never frames

**Status:** Accepted
**Date:** 2026-08-02

## Context

Two of Riki's hardest constraints meet at the same interface.

**Privacy.** [dota2-state-capture-design.md](../design/dota2-state-capture-design.md) §7 makes
window-scoped capture the whole privacy story: targeting one window structurally excludes Discord,
browsers, notification toasts and second monitors, with no filtering heuristic to get wrong.

**Performance.** §2.2 makes crop-first the whole performance story: reading back N small crops
instead of a 4K frame is roughly a 50× cut in PCIe traffic, and it only holds if the crop happens
while the frame is still on the GPU — an `IOSurface` under `ScreenCaptureKit`, a D3D11 texture
under WGC.

Both are easy to state and easy to lose. A seam that hands a caller a whole frame invites a full
desktop capture and a CPU-side crop, and both would be a one-line change made by someone in a
hurry.

## Decision

`riki_capture::CaptureBackend` takes a `WindowTarget` and a region list, and returns cropped
regions. It has **no method that yields a display, a desktop, or a whole frame**, and the protocol
has no message that can ask for one — a capture target is a process name and a title fragment, and
there is no display id anywhere in `packages/protocol`.

Cropping is the backend's job, not its caller's, so the ordering holds wherever the frame lives.

Everything above the seam — geometry resolution, hashing, the change gate, and the diagnosis that
turns a run of black frames into a permission problem — is platform-independent and is tested
against a replay backend over recorded frames.

## Consequences

- "Never full-desktop" is a property of the type rather than of everyone's memory. There is no
  correct way to write the wrong thing.
- A CPU backend does more work than it would if it received frames, because it crops per region
  rather than once. `ReplayBackend` is the only such backend and it is not on the budget.
- The **macOS black-frames-mean-permission-denied** behaviour is expressible without macOS: the
  backend declares the policy in `BackendInfo` and `riki_capture::health` acts on it, so that
  failure mode has tests on a Linux box.
- Downscaling is not on the seam yet. When it lands it belongs inside the backend for the same
  reason cropping does, and `CaptureRegion` gains a field rather than the trait gaining a method.
- **No live backend is implemented.** Every platform resolves to an `UnavailableBackend` that
  reports `backend_unavailable` over the protocol. The dev box for this repository is headless
  Linux with no session bus, no `PipeWire` daemon, and no `clang` — so `pipewire-sys`, which is
  `bindgen` over `libpipewire`, does not compile there, let alone run. Writing a backend that could
  be neither run nor compiled was judged worse than a seam with an honest report behind it. What
  each platform still needs is recorded in `crates/riki-capture/src/platform.rs`.

## Alternatives rejected

- **`fn frames() -> Frame` with cropping above the seam.** Simpler to write and it inverts both
  constraints at once: the crop moves off the GPU and the natural implementation captures a screen.
- **A `capture_screen` method behind a config flag.** A flag is a thing that gets set. The
  requirement is that the capability not exist.
- **Half a `PipeWire` backend** — the portal negotiation via `ashpd` (which does compile on the dev
  box) with the stream consumption stubbed. It would have been unrunnable *and* unfinished, and an
  abandoned half is harder to complete than an empty seam.

See [ADR-0003](0003-read-only-observation-only.md), the `vision-sidecar` skill, and
`dota2-state-capture-design.md` §2.2 and §7.

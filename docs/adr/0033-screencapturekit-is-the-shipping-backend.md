# ADR-0033: `ScreenCaptureKit` is the shipping backend, and it is cross-compiled rather than run

**Status:** Accepted
**Date:** 2026-08-02

## Context

[ADR-0030](0030-the-capture-seam-returns-cropped-regions-never-frames.md) settled the shape of the
capture seam and left every platform behind it unimplemented, because the development box for this
repository is headless Linux and could not build or run any of them. macOS is the shipping target
([ui-design.md](../design/ui-design.md) A3), so the backend that actually has to be correct is the
one nobody in the loop can execute.

That is an unusual position to write code from, and the tempting responses are both bad. Waiting
for hardware leaves the shipping platform empty indefinitely. Writing it blind and calling it done
ships several hundred lines of Objective-C interop whose first execution is on a user's machine.

The question this ADR answers is therefore not "how do we capture on macOS" — the design already
says `SCContentFilter` over the Dota `SCWindow` — but **how much of that can be made true without a
Mac, and what is honestly left over.**

## Decision

The macOS backend is implemented in full, in `crates/riki-capture/src/macos.rs`, as a single
`SCStream` scoped to one window by `SCContentFilter::initWithDesktopIndependentWindow:`. Four
choices are load-bearing:

**Cross-compilation is the verification, and it is a real one.** `rustup target add
aarch64-apple-darwin` gives a Linux box a Darwin `std`, and `cargo check`/`clippy`/`build --target
aarch64-apple-darwin` then type-check, lint and codegen the `#[cfg(target_os = "macos")]` module
against Apple's real framework signatures — the objc2 binding crates are pure Rust and need no
macOS SDK until link time, which `cargo build` of an rlib never reaches. This is far stronger than
"it looks right": it caught wrong block types, a deprecated CoreGraphics pair, and every numeric
cast in the file. It is *not* execution, and the gap is enumerated below.

**Apple's frameworks through objc2, not a third-party capture crate.** `objc2-screen-capture-kit`
and friends are generated bindings maintained against the headers; a wrapper crate would add a
dependency with its own opinions to a process on a ≤3% CPU budget. They are declared under
`[target.'cfg(target_os = "macos")'.dependencies]` with `default-features = false`, so a Linux or
Windows build never resolves them and the defaults — which pull `SCRecordingOutput` and
AVFoundation — never arrive. A read-only observer
([ADR-0003](0003-read-only-observation-only.md)) should not link a recording API.

**The delegate crops; `capture` only collects.** `SCStream` pushes frames on a dispatch queue and
the seam pulls on a timer. The adaptation is a shared slot, and the crop happens on the push side,
so what is copied out of the mapped `IOSurface` is region-sized rather than frame-sized — ADR-0030's
crop-first rule, in the one place on macOS where it can still be lost. A consequence that reads
like a bug and is not: `capture` returns the *previous* crops when no new frame has arrived,
because a window that has stopped changing has stopped producing frames and those crops still
describe it.

**The decidable logic lives above the `cfg`.** Window selection (`window_match.rs`) and the
BGRA→RGBA strided crop (`pixels.rs`) are platform-neutral modules with 23 unit tests that run on
Linux. They are where the bugs would otherwise be — picking a browser tab titled "Dota 2", or
assuming `bytesPerRow == width * 4` — and they are now the part of the macOS path that *is*
executed in CI. A Windows WGC backend should fill the same structures rather than reimplement them.

`CaptureBackend` also gains a defaulted `set_frame_interval`, called before `acquire`. Without it
`SCStream` runs at the display's refresh rate and the delegate crops sixty times a second for a
consumer reading five.

## Consequences

`platform::default_backend()` now returns a working backend on macOS, `backendAvailable` is `true`
in the handshake there, and `vision.enabled` can stop being pinned off for reasons of "no platform
backend exists". Linux and Windows are unchanged and still report themselves unavailable by name.

**What is compile-verified:** every signature, type, lifetime and cast in the module; clippy at
`pedantic` with `-D warnings` for the Darwin target; the licence and ban audit, since `cargo deny`
walks all targets and sees all fourteen new crates.

**What has never executed, and must be checked on real hardware before anyone calls this done:**

1. **The Screen Recording permission dialog.** Both mapped signals — `SCShareableContent` failing
   with `SCStreamErrorUserDeclined` (−3801), and a started stream delivering black frames — are
   coded from Apple's documentation, not observed. The error code in particular is a constant
   nobody has seen fire.
2. **Any frame at all.** Nothing has confirmed that a delivered `CVPixelBuffer` is 32BGRA, that
   `bytesPerRow` padding behaves as `pixels.rs` assumes, or that the first frame arrives inside the
   3-second budget.
3. **The performance budget.** ≤3% of one core, ≤50 MB GPU memory and no measurable FPS delta are
   design constraints here, not measurements. `minimumFrameInterval` and `queueDepth = 1` are the
   levers; whether they suffice is unknown.
4. **Exclusive fullscreen.** The path is coded — the stream stops, which `health` reads as the
   fullscreen signature once a window has been acquired — but the assumption that macOS tears the
   stream down rather than delivering black is untested.
5. **Multi-monitor backing scale.** `backing_scale()` reads the *main* display, so a window on a
   second display with a different scale factor is captured at the wrong resolution. Regions still
   resolve correctly, because geometry comes from the pixel buffer rather than from the window
   frame, so this degrades sharpness rather than correctness.
6. **`Transfer<T>`.** A hand-written `unsafe impl Send` for moving a retained Objective-C object out
   of a completion handler. The argument is transfer-not-sharing with the channel as the
   synchronisation edge, and it is the one place in the file where being wrong is a data race
   rather than a bad picture.

The honest summary: this is a complete implementation with a verified skeleton and an unverified
nervous system. A follow-up session on a Mac should run `--backend native` against Dota in
borderless windowed mode, work items 1–4 in that order, and record the numbers.

## Alternatives rejected

**`SCScreenshotManager` instead of a stream.** Its pull model fits the seam far better — one call
per pass, no delegate, no shared slot, no push-to-pull adaptation at all. Rejected because it is
macOS 14+, and the design's floor is 12.3. Worth revisiting if that floor ever rises; it would
delete most of the concurrency in this module.

**One `SCStream` per region, each with its own `sourceRect`.** This is the purest reading of
crop-first: ScreenCaptureKit itself does the GPU crop and each delivered buffer contains only one
region. Rejected as speculative — several concurrent capture sessions on one window is an unusual
configuration with unknown cost, and on Apple Silicon the unified memory that makes a single mapped
`IOSurface` cheap is exactly what makes the simpler design fine. Revisit only if profiling on
hardware says the single-stream copy is actually the problem.

**Waiting for hardware.** Leaves the shipping platform empty and the seam unexercised by anything
except a replay backend, which is how a design drifts away from the API it claims to target.

**Shipping it blind, without cross-compilation.** This was the default until `rustup target add`
turned out to work. Three classes of error the compiler found in the first pass would otherwise
have reached a user's machine.

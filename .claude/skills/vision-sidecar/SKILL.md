---
name: vision-sidecar
description: The Rust capture and computer-vision sidecar in `crates/` — window-scoped capture on ScreenCaptureKit/PipeWire/WGC, GPU crop-first pipeline, region hashing, template matching, and the performance budget. Also covers the read-only observation rule that keeps Riki VAC-safe. Use when working on capture, CV, the sidecar process or its benchmarks.
---

# The capture and CV sidecar

Two constraints dominate everything in this crate tree, and both are absolute.

## 1. Read-only observation, always

**No memory reads, no injection, no input synthesis, no game-process interaction of any
kind.** Riki observes what is on screen and what Valve's own integration hands us, and
nothing else. Getting a player VAC-banned is a product-ending failure, and no feature is
worth approaching the line.

Capture is **window-scoped, never full-desktop**, on all three platforms. That is a privacy
rule as much as a technical one — the player's other windows are not ours to see. Borderless
windowed mode is required; exclusive fullscreen degrades or breaks window capture
everywhere, so detect it and prompt once.

**The primary backend is ScreenCaptureKit, it exists, and you probably cannot run it.** macOS is
the shipping target (`ui-design.md` A3) but the dev box is Linux, so PipeWire is what keeps the
pipeline developable and ScreenCaptureKit is what has to be correct. It is now implemented
(`crates/riki-capture/src/macos.rs`, [ADR-0033](../../../docs/adr/0033-screencapturekit-is-the-shipping-backend.md))
and **compile-verified for `aarch64-apple-darwin` but never executed** — see the first Learning
below for how to check it from Linux, and that ADR's Consequences for the six things that still
need a Mac. Treat those six as unproven until someone records otherwise; "it compiles" is not
"it captures".

Two working rules follow: keep the `CaptureBackend` seam narrow — frames in, cropped regions out —
so nothing platform-specific leaks up into `riki-cv`, and make every layer above it exercisable
against recorded frames with no backend at all. macOS also gates capture behind the **Screen
Recording** permission, which returns black frames rather than an error when denied; detect
that and report it as a permission problem, not a CV failure.

## 2. The performance budget is the feature

≤3% of one CPU core average, ≤50 MB GPU memory, **no measurable FPS delta**. A
coach that costs frames is a coach that gets uninstalled.

- **Crop first, on the GPU, then read back.** Reading back N small crops instead of a 4K
  frame cuts PCIe traffic by roughly 50×. This ordering is the whole performance story.
- **Hash each region and drop it if unchanged.** The scoreboard region then costs nothing
  for the 95% of a match it is closed.
- **Recognition cheapest-first.** Dota is a fixed-layout, fixed-font, sprite-based renderer,
  so general OCR is the wrong default tool:
  1. digit/glyph template matching for all numerals,
  2. icon template matching (normalised cross-correlation) for heroes, items, abilities,
  3. minimap detection by colour-keying to candidate blobs, then matching the glyph,
  4. real OCR only for free text (chat), on change rather than on a timer,
  5. a VLM on a downscaled frame only when the agent explicitly asks, ≤1 per 5 s, never
     scheduled.
- Atlases are built per HUD scale, once, and ship with the binary.

## The process boundary

The sidecar is a separate process so that a CV crash does not take the voice agent down. It
must behave well under a supervisor: clean stdio protocol, restart with backoff, and no
assumption that the app it is talking to is the same build (`protocol` skill).

Every CV fact leaves this process with a **confidence score, provenance and a timestamp**.
There is no path that emits a bare fact.

## Benchmarks

criterion micro-benchmarks are CI-gated with regression thresholds: region hash, template
match, minimap pass, calibration solve. CV correctness uses `insta` snapshots against
`fixtures/frames/` with an **F1 floor rather than exact equality** — minimap accuracy is the
load-bearing assumption of the entire vision layer and needs a number in CI.

The frame-time harness (Dota's 1% low, with and without Riki, on real hardware) cannot run in
CI. It is a release gate, and its numbers get committed.

## Learnings

**2026-08-02 — you can compile and lint the macOS backend on Linux, and you should.** The skill
above says "the primary backend is `ScreenCaptureKit`, and you probably cannot run it". True — but
*running* it and *checking* it are different, and the second one works here:

```sh
rustup target add aarch64-apple-darwin        # ~30 s, downloads a Darwin std
cargo check   -p riki-capture --target aarch64-apple-darwin
cargo clippy  -p riki-capture --target aarch64-apple-darwin --all-targets -- -D warnings
cargo build   -p riki-capture --target aarch64-apple-darwin   # rlib only; never links
```

This type-checks the `#[cfg(target_os = "macos")]` module against Apple's real signatures. No macOS
SDK is needed because the objc2 binding crates are pure Rust — the frameworks are only wanted at
*link* time, which building an rlib never reaches. Linking a **binary** for Darwin still fails, so
`cargo build -p riki-vision --target aarch64-apple-darwin` is not a thing you can do.

*Why this matters more than it sounds:* code behind a `cfg` for another platform is **not**
type-checked by an ordinary `cargo check`. Only syntax errors surface. Everything else — wrong
types, missing features, renamed APIs — compiles silently on Linux and explodes on the target. The
first cross-check of `macos.rs` found three real errors (block arguments needed
`Some(&handler)`, `CMSampleBuffer::image_buffer` needed the `objc2-core-video` feature on
`objc2-core-media`) and clippy then found seventeen more, including a deprecated CoreGraphics pair
and every numeric cast. All of that would otherwise have been discovered by a user.

**Do this for any `cfg`-gated platform code before you claim it is done.** It is the difference
between "unverified" and "compile-verified", and only one of those is worth committing.

**2026-08-02 — objc2 feature flags are per-class, and `default` pulls things a read-only observer
must not link.** `objc2-screen-capture-kit`'s defaults include `SCRecordingOutput` and
`SCContentSharingPicker`, which drag in AVFoundation — a recording API, in a process whose whole
premise is ADR-0003. Use `default-features = false` and name the classes you need (`SCStream`,
`SCShareableContent`), plus the *dependency* features that carry the types across crates
(`objc2-core-media`, `dispatch2`, `block2`). Declare all of it under
`[target.'cfg(target_os = "macos")'.dependencies]` so no other platform resolves it. Symptom of
getting a feature wrong: a method simply does not exist, with no hint that a flag is why.

**2026-08-02 — `cargo deny` does see target-scoped dependencies, so the audit is real.** With no
`[graph] targets` in `deny.toml` cargo-deny walks *all* targets, so the fourteen macOS-only crates
were licence-checked from Linux (`cargo deny list | grep objc2` to confirm they are in the graph).
Do not add a `targets` key to narrow it — that would silently stop auditing the crates that ship on
the platform users actually run.

**2026-08-02 — put the decidable half of a platform backend above the `cfg`.** `window_match.rs`
(which window is Dota's) and `pixels.rs` (BGRA→RGBA at a padded stride) are compiled on every
platform and carry 23 tests that run on Linux. They are where the bugs actually live — selecting a
browser tab titled "Dota 2", or assuming `bytesPerRow == width * 4`, which shears the image
progressively down the frame — and inside a `cfg` block none of it would be executed by anything.
This is the same move `health` already made for the black-frame policy, applied one layer down. The
Windows backend should fill the same structures rather than write its own.

**2026-08-02 — the dev box cannot build the `PipeWire` backend, let alone run it.** The skill above
says `PipeWire` "keeps the pipeline developable day to day". On the machine this was written on it
does not, and the reasons are worth checking before you plan around it:

| Needed | Present? |
|---|---|
| `libpipewire-0.3` headers (`pkg-config --modversion`) | yes, 1.0.5 |
| `clang` / `libclang`, for `pipewire-sys`'s `bindgen` | **no** — `pipewire-rs` will not compile |
| `DBUS_SESSION_BUS_ADDRESS`, for the `ScreenCast` portal | **no** |
| A `PipeWire` daemon, a compositor, `DISPLAY`/`WAYLAND_DISPLAY` | **no** — headless |

`ashpd` (pure-Rust portal client, `--no-default-features --features async-io`) *does* compile in
~13 s, so the portal half is buildable and only the stream half is blocked. That was still judged
not worth landing: half a backend that always fails at the last step is harder to finish than an
empty seam ([ADR-0030](../../../docs/adr/0030-the-capture-seam-returns-cropped-regions-never-frames.md)).
*Why:* run `which clang && echo $DBUS_SESSION_BUS_ADDRESS` before you promise anyone a working
Linux capture. What is developable here is everything *above* the seam, against
`ReplayBackend` — and that is now real, so use it.

**2026-08-02 — the macOS failure modes are testable without macOS, if the policy lives above the
seam.** The two that matter — Screen Recording denied (black frames, no error) and exclusive
fullscreen (the window stops being visible) — are both invisible in a single capture call. So
`BackendInfo::black_frames_mean_permission_denied` is a declaration by the *platform*, and
`riki_capture::health` turns runs of passes into a named `ProblemKind`. A window that vanishes
after being acquired is exclusive fullscreen; one that was never acquired is simply not running.
Both report **once per streak**, not once per pass. *Why:* the temptation is to put this logic in
the macOS backend, where nobody in the loop can run it. Above the seam it has unit tests on a Linux
box, and the day `ScreenCaptureKit` lands it inherits behaviour that already works.

**2026-08-02 — `--backend replay --frames <dir>` is the fastest way to see the whole path.** The
sidecar loads `.ppm` frames in name order and runs the real protocol loop over them:

```sh
cargo build -p riki-vision
printf '{"v":1,"type":"hello","app":{"name":"riki","build":"manual"}}\n{"v":1,"type":"capture.configure","config":{"target":{"processName":"dota2","titleContains":"Dota 2"},"regions":[{"id":"minimap","rect":{"x":0,"y":0.75,"w":0.18,"h":0.25}}],"intervalMs":100}}\n{"v":1,"type":"capture.start"}\n' \
  | ./target/debug/riki-vision --backend replay --frames fixtures/frames/synthetic
```

PPM rather than PNG because it needs no decoder — an image crate in the shipped binary for the
benefit of tests alone is a dependency the perf budget does not owe anyone. `fixtures/frames/` is
git-lfs for `*.png`/`*.jpg` only, so a small `.ppm` commits plainly.

**2026-08-02 — an unchanged region is still reported, with `changed: false`.** The gate skips
*recognition*, not reporting. `apps/desktop/src/main/sidecar` treats five quiet seconds as
`degraded`, so a sidecar that went silent while the scoreboard was closed would be
indistinguishable from one that had wedged. *Why:* if you are tempted to suppress unchanged
digests to save bytes, you are trading a liveness signal for nothing measurable at 1–5 Hz.

**2026-08-01 — `clippy::pedantic` is on, and `doc_markdown` will fail your doc comments.**
`Cargo.toml` sets `pedantic = "warn"` at the workspace level and `pnpm lint:rust` passes
`-D warnings`, so a warning is a build failure. `doc_markdown` flags any bare identifier-looking
word in a `//!` or `///` comment — `PipeWire`, `ScreenCaptureKit`, `REPO_SKELETON.md` — and the
skeleton's own three `lib.rs` headers all failed the first time a toolchain existed to run them.
*Why:* backtick product and file names in doc comments as you write them. `cargo clippy --fix`
applies these automatically if you have already made the mess.

**2026-08-02 — cargo-deny's `wildcards = "deny"` also fires on our own path dependencies.**
The first commit in which one workspace crate depended on another failed `cargo deny check bans`
with `found 2 wildcard dependencies for crate 'riki-vision'` — because `riki-ipc = { path = ... }`
carries no version, and that is what a wildcard looks like. Fixed with `allow-wildcard-paths = true`
under `[bans]`. *Why:* this is the second time cargo-deny has failed on **us** rather than on a
dependency (see the entry below), and the failure reads like a supply-chain problem. If
`cargo deny` starts failing after you add a crate, check which side it is complaining about before
you go looking at the dependency tree. It runs in the pre-commit hook, not in `pnpm check`, so it
surfaces at the commit rather than while you are working.

**2026-08-01 — `license = "UNLICENSED"` is not valid SPDX, and cargo-deny fails on it.**
The workspace crates inherit it from `[workspace.package]`, so `cargo deny check` reported
`error[unlicensed]` on all four members before it looked at a single dependency. Fixed with
`private = { ignore = true }` under `[licenses]` in `deny.toml`, which is the right scope
anyway — the allow-list is about what we *ship*, not about our own unpublished crates.
*Why:* if you add a crate and cargo-deny starts failing, check whether it is complaining about
us rather than about a dependency.

## See also

`docs/dota2-state-capture-design.md` §2.2 (capture and CV), §8 (anti-cheat and
fairness), §9 (failure modes); `REPO_SKELETON.md` §5.6.

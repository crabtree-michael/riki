---
name: vision-sidecar
description: The Rust capture and computer-vision sidecar in `crates/` — window-scoped capture on WGC/PipeWire/ScreenCaptureKit, GPU crop-first pipeline, region hashing, template matching, and the performance budget. Also covers the read-only observation rule that keeps Riki VAC-safe. Use when working on capture, CV, the sidecar process or its benchmarks.
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

**2026-08-01 — `clippy::pedantic` is on, and `doc_markdown` will fail your doc comments.**
`Cargo.toml` sets `pedantic = "warn"` at the workspace level and `pnpm lint:rust` passes
`-D warnings`, so a warning is a build failure. `doc_markdown` flags any bare identifier-looking
word in a `//!` or `///` comment — `PipeWire`, `ScreenCaptureKit`, `REPO_SKELETON.md` — and the
skeleton's own three `lib.rs` headers all failed the first time a toolchain existed to run them.
*Why:* backtick product and file names in doc comments as you write them. `cargo clippy --fix`
applies these automatically if you have already made the mess.

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

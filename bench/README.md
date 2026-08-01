# Benchmarks

Two separate things, often conflated (REPO_SKELETON.md §5.6).

## `cv/` — micro-benchmarks, CI-gated

Criterion benchmarks over `crates/riki-cv`: region hash, template match, minimap pass,
calibration solve. A regression against the baseline on `main` fails the build. Cheap, and it
catches the obvious. Run with `pnpm bench`.

## `frametime/` — the harness that actually matters, manual

The metric the product lives or dies by is **Dota's 1% low frame time with Riki running versus
not**, on a low-end machine, at 1080p / 1440p / 4K. This cannot run in CI and cannot be faked.

It runs on real hardware before a release, and the numbers get committed to
`docs/runbooks/perf-results/`. **A release that has not run it is not a release.**

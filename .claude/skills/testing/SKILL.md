---
name: testing
description: How to test Riki without a running Dota 2 client, a real microphone, a GPU, or a live OpenAI session — the four shared fakes, the fixture corpus, the test tiers, and which tier a given test belongs in. Use when writing or fixing any test, adding a fixture, or deciding whether something is testable at all.
---

# Testing without a game

> **No test may require a running Dota 2 client, a real microphone, a GPU, or a live OpenAI
> session.** Every external input has a fixture and a fake.

This is the load-bearing rule of the repo. Agents building Riki cannot run Dota, cannot
speak into a microphone, and should not spend money on live Realtime sessions. Break this
rule and every task in the area ends with "untested, please check."

## The four fakes

They ship as `testing/` subpath exports, so any package can import them.

| Fake | Replaces | Behaviour |
|---|---|---|
| `FakeGsiSource` | The Dota client's POSTs | Replays `fixtures/gsi/*.jsonl` at recorded or accelerated timing |
| `FakeVisionSidecar` | The Rust process | Scripted protocol messages, including crashes, stalls and low-confidence output |
| `FakeRealtimeTransport` | OpenAI | Replays `fixtures/realtime/*`, records what we sent, injects errors and mid-response disconnects |
| `FakeAudioDevice` | Mic + speakers | Feeds known PCM, captures output |

They are not test scaffolding. `pnpm dev:replay` drives the whole app through the same
fakes, which is what keeps them honest — a fake that drifts from reality breaks a developer's
dev loop, not just a test.

## Which tier

Write the test at the **lowest tier that can catch the bug**.

1. **Unit** — pure functions, no I/O, milliseconds. Fusion precedence, staleness decay,
   derived arithmetic, token budgeting, salience scoring, template match scoring, audio
   envelope math. This should be the bulk of what you write.
2. **Golden** — committed expected output, reviewed as a diff. The snapshot renderer's
   output *is* the interface to the LLM, so a format change should look like a diff. CV
   detections use `insta` against `fixtures/frames/` with an **F1 floor, not exact
   equality**.
3. **Contract** — TS and Rust parse the same corpus and must agree (`protocol` skill).
4. **Integration** — replay a recorded match end to end, assert the latency budgets and the
   documented failure modes (heartbeat miss, sidecar crash, pause).
5. **End-to-end** — Playwright on a real Electron build. The only place a window launches.
6. **Performance** — criterion micro-benchmarks gated in CI; the frame-time harness is
   manual, on real hardware, and is a release gate rather than a CI job.

## Fixtures

**Add the fixture in the same commit as the code.** A parser without a fixture is untestable
by the next agent, and they will not have your recording.

`fixtures/frames/**` is git-lfs. Tests needing frames must skip with a clear message when
the LFS objects are absent, not fail cryptically.

## What is genuinely untestable

Say so rather than faking coverage. Anti-cheat interaction, real CV accuracy in a chaotic
teamfight, whether Riki is *annoying*, and exclusive-fullscreen capture behaviour all need a
runbook and a human, not a test. Write the runbook in `docs/runbooks/` and commit its result.

Coverage is reported, not gated at a blanket number — except in `packages/world-model`,
`packages/context` and `packages/events`, where a silent bug becomes wrong advice in a
player's ear.

## Learnings

**2026-08-01 — Tier 5 needs a display, and `xvfb-run` is enough of one.** Playwright's
`_electron` launches a real window, so on a headless box (no `DISPLAY`, no `WAYLAND_DISPLAY`)
it fails in the launch call, not in your assertions. Verified end to end against a throwaway
Electron main + `_electron.launch()`:

```sh
xvfb-run -a --server-args="-screen 0 1920x1080x24" pnpm test:e2e
```

Two things worth knowing before you burn time on them. **No Playwright browser download is
needed** — `_electron` drives the Electron binary the app already depends on, so
`playwright install` is not part of setup for tier 5. And a stray
`ERROR:zygote_linux.cc … Broken pipe` on the way out of a passing run is Chromium sandbox
teardown noise under Xvfb, not a failure — assert on the test result, not on clean stderr.

*Why:* the failure without a display is a Playwright launch timeout with a wall of process
output, which reads like a broken harness rather than a missing X server.

**2026-08-01 — there is a fifth Vitest project, and DOM tests are Tier 1.** `desktop-renderer` runs
`apps/desktop/src/renderer/**/*.test.ts` on `happy-dom`; the node-env `desktop` project now lists
`src/main`, `src/preload`, `src/shared` and `test/` explicitly rather than all of `src`. An
in-memory document needs no game, microphone, GPU or window, so §5.2 holds and view code does not
have to wait for Tier 5 to be tested at all. Tier 5 is still the only place a *window* launches.

*Why:* the alternative was shipping ~600 lines of untested DOM code against a Playwright harness
that does not exist yet, which is the "untested, please check" outcome this skill exists to prevent.

**2026-08-01 — a fake needs a hand-crank, or its tests sleep.** `FakeGsiSource` has `step()`/`drain()`
and `ConsoleLogTailer` has `poll()` for the same reason: the alternative is a test that waits out a
250 ms poll or a recorded 30 s heartbeat, which is slow when idle and flaky under load. Both default
to *not* running their timer (`speed: 0`), so the timing path exists for `pnpm dev:replay` and the
tests never touch it. *Why:* it is much easier to add the crank while writing the fake than to
retrofit it into a suite that has already learned to sleep.

**2026-08-01 — the synthetic fixtures are labelled, and the label is load-bearing.**
`fixtures/gsi/*.jsonl` and `fixtures/console-log/*` were assembled from the design docs, not
captured — no one has a machine that can run Dota. Both carry a header (JSONL fixtures skip `//`
lines, which is why that is supported) saying so and saying what a real recording would settle.
*Why:* a synthesised fixture and a captured one look identical and are worth very different amounts;
without the label the next agent reasonably assumes the delivery rates and line formats in them were
observed.

## See also

`REPO_SKELETON.md` §5 (testing), §5.4 (the specific tests the specs already asked for).

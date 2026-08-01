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

## See also

`REPO_SKELETON.md` §5 (testing), §5.4 (the specific tests the specs already asked for).

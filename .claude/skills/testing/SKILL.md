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
| `FakeVisionSidecar` | The Rust process | Scripted protocol messages, including crashes, stalls and low-confidence output. `@riki/protocol/testing`; plugs in as a `ChildProcessPort`, so the supervisor, the codec and fusion are all real |
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

Coverage is reported, not gated at a blanket number — except in `packages/world-model` and
`packages/context`, where a silent bug becomes wrong advice in a player's ear.

## Learnings

**2026-08-02 — a fake is not only a convenience; sometimes it is the only thing that can run a leg
of the loop at all, and building it is how you find the leg is broken.** `FakeVisionSidecar` was the
last of the four to be written, and the reason mattered: `crates/riki-vision` captures on macOS
alone (never executed), and its portable `--backend replay` emits only region digests, which carry
no game fact. So **no machine anywhere had ever run vision → world model → coaching**. The first
thing the fake did was reveal that `protocol-codec.ts` emitted the wire shape verbatim while
`readCvDetections` reads a flat record — one batch applied to a real store gave
`{ accepted: 0, rejected: [{ why: 'unparsed' }] }`, silently, forever (ADR-0035).

Three things worth copying:

- **Fake at the narrowest port, not at the convenient one.** `ChildProcessPort` means the
  supervisor, the codec, the restart backoff and fusion are all the real thing. A fake of
  `SidecarSource` would have been half the code and would have tested none of them.
- **Write the negative control in the same file.** `apps/desktop/test/vision-coaching.test.ts`
  asserts `enemy_missing` fires *and* that it does not when the crank is never turned. Without the
  second, the first proves only that something fired.
- **Assert against the real consumer, not against your belief about it.** The Tier 1 test that
  caught the shape mismatch is one line — decode a message, `createWorldModelStore().apply(it)`,
  expect `rejected` empty. Everything else in that file agreed with the codec because it was
  written from the same misunderstanding.

*Why:* "there is a fake for it" and "the path has run" are different claims, and this repo believed
the first for both of the fakes that had no consumer test.

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

**2026-08-02 — a test may depend on our own build output, if it skips loudly.** §5.2 forbids a test
that needs Dota, a microphone, a GPU or a live session. It says nothing about `target/debug/`, and
`apps/desktop/test/sidecar-process.test.ts` is the one place both languages are in the room — it
spawns the real `riki-vision` through the real `ChildProcessPort` and asserts a `cv.detections`
comes back as an `Observation`. It guards on `existsSync(BINARY)` and `describe.skip`s with the
command that fixes it, mirroring what `scripts/cargo.mjs` already does at the other end. *Why:* a
hard failure would stop a TypeScript-only agent running `pnpm check` at all — but check the run
output, because "1025 passed" and "1025 passed, 3 skipped" are different claims and only one of them
means the two languages agree. Verify the skip by moving the binary aside, not by assuming.

**2026-08-02 — `apps/desktop/test/` is its own tsconfig project, so importing from `src/main`
needs a reference.** Under `tsc --build` every file belongs to exactly one project, and an import
that reaches into another one is `TS6307` — which reads like a missing file rather than a missing
`references` entry. `tsconfig.test.json` now references `tsconfig.main.json`. *Why:* Vitest resolves
it happily and the test passes long before `pnpm typecheck` disagrees, so this fails at the gate
rather than while you are writing it.

**2026-08-04 — a test over fused world state can pass against a deliberately broken fusion, because
the game clock is carried in the payload and is not a function of *when* you applied it.** ADR-0038's
rehearsal slides a `fixtures/gsi/*.jsonl` onto main's clock so the last line lands on `now`; applied
at recorded times instead, every fact ages to `expired` and the snapshot renders as an empty match.
The first test for this asserted `snapshot(now).clock !== null` and **passed with the sliding
removed** — `map.clock_time` is 601 in the recording either way. `state.meta.lastUpdatedAt` is the
field that moves, because it is the observation stamp rather than the recorded value.

*Why:* the general rule is worth more than the instance. **When a test covers *when* something was
observed, assert on a stamp the harness controls, never on a value the fixture carries** — and prove
it by breaking the implementation on purpose and watching the test fail. Two minutes with `python3 -`
and a string replace is the whole technique, and it is the only thing that distinguishes a test that
guards behaviour from one that merely runs it.

**2026-08-09 — two mechanisms that agree can hide the fact that only one of them works.** Session
renewal (ADR-0045) collapses a duplicated expiry signal twice: `packages/realtime`'s session reports
one fault per loss, and main's supervisor joins a renewal already running. The end-to-end test drove
a real expiry through both and passed — and **still passed with main's guard deleted**, because the
first mechanism meant main only ever saw one fault. The second guard was decoration until a test
pushed two faults straight across the bridge, past the first one.

*Why:* redundancy is worth having and is exactly the shape mutation testing catches nothing in. When
you write a belt-and-braces guard, ask which test would fail if you removed *this* one — and if the
answer is "the other mechanism covers it", the test you have is for the other mechanism. Delete each
guard in turn and run the suite; it is thirty seconds per guard.

**2026-08-09 — `await Promise.resolve()` does not settle anything that crosses a seam.** A renewal is
main's mint (a promise), then a directive, then the renderer's own open, which is several awaits
deep. A fixed count of microtask ticks gets partway and then passes assertions about a step that has
not happened — including `expect(...).toHaveLength(2)` on directives, while the object those
directives were supposed to build did not exist yet. `await new Promise((r) => setTimeout(r, 0))` in
a short loop is the flush that works. `transport.test.ts` had already documented this for the SDP
round trip; it is a general fact about anything with a fake `fetch` in the middle.

**2026-08-09 — a hand-written expected shape in a test can agree with a wrong implementation; infer
it from the schema instead.** `tools.test.ts` first typed each result as
`Record<string, ToolFact<unknown>>` and cast fields at every assertion. That compiles against a
projection with a misspelled key, a missing field or a wrong nesting — the cast simply says "trust
me". Typing the helper as `parse<T>(schema: { parse(v: unknown): T }, …): Exclude<T, UnknownFact>`
makes zod's own inferred type flow into every assertion, so the *test* stops compiling when the
projection drifts. It also deleted twenty `!` assertions, which is how you can tell the types got
real rather than merely stricter — `@typescript-eslint/no-unnecessary-type-assertion` flags them all
at once.

Two notes. A generic used only in a return position trips
`@typescript-eslint/no-unnecessary-type-parameters`, and that rule is pointing at exactly this
mistake: a type parameter the caller supplies is a cast wearing a hat. And a runtime `schema.parse`
in the test is still worth keeping alongside — it is the only thing that catches a value that has
the right *type* and violates a `.min(0)` or a regex. *Why:* for a boundary validated at run time,
"the test passes" and "the model would have accepted this" are different claims.

**2026-08-09 — POSTing a GSI fixture back to back at a live listener empties the world model, and
the app is right to do it.** A probe that replays `fixtures/gsi/laning-phase.jsonl` at full speed
gets `world.version = 0`, `my_state → {unknown: 'no match is in progress'}`, and eleven
`world model reset: clock_discontinuity` problems. Nothing is broken: the fixture's `map.clock_time`
advances 176 seconds across 22 frames, the wall clock advances milliseconds, and detecting exactly
that mismatch is what `drift.ts` is for. Pace the POSTs to the fixture's own `atMs` deltas —

```js
if (lastAt !== null) await new Promise((r) => setTimeout(r, line.atMs - lastAt));
```

— and the same replay gives 23 versions and every tool a real answer. It costs the fixture's real
duration (~3 minutes here), which is why `shell.test.ts` uses a **fake** clock and
`clock.advance(gapAfter(index))` instead; only an out-of-process probe has to pay it.

*Why:* the symptom is "the tools return unknown", which reads as a broken dispatcher rather than as
a fixture played too fast — and the resets are only visible if you print the inspector's Problems
list, which a probe has no reason to do until it has already lost an hour.

**2026-08-09 — the test that would have caught T12 was the one nobody had a place to put.** Five
tickets' worth of tool code (T2, T3, T4, T6, T9) shipped green, and in a real match none of it ran:
the session is in a renderer, the world model is in main, and no message joined them. Every layer
was individually tested; the seam was not, because the seam is not in any one project's directory.

`apps/desktop/test/` is that place, and the pattern is worth copying whenever a boundary has two
real halves: import both, join them with the actual messages, and replace only the transport —
here `JSON.parse(JSON.stringify(x))`, which is exactly what Electron's IPC guarantees and nothing
more, so anything unserialisable fails in Vitest rather than in a window. It needed one line of
setup: `tsconfig.test.json` had to reference `tsconfig.renderer.json` as well as
`tsconfig.main.json`, or the import is `TS6307`.

*Why:* the rule "write the test at the lowest tier that can catch the bug" is right, and its failure
mode is that a bug living *between* two tiers gets tested at neither. If a ticket's own summary
names two processes, the test belongs in `apps/desktop/test/`.

## See also

`REPO_SKELETON.md` §5 (testing), §5.4 (the specific tests the specs already asked for).

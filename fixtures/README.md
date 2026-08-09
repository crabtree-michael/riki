# Fixtures

`fixtures/` is a first-class directory, not a test subfolder: multiple packages, both
languages, and the dev tools all read from it (REPO_SKELETON.md §2.1).

It exists because of one rule (§5.2):

> No test may require a running Dota 2 client, a real microphone, a GPU, or a live OpenAI
> session. Every external input has a fixture and a fake.

Agents cannot run Dota 2, cannot use a real microphone, and should not spend money on live
Realtime sessions. Without fixtures every task would end in "untested, please check".

**Add the fixture alongside the code.** A parser without a fixture is untestable by the next
agent (§9).

## `gsi/`

Recorded GSI sessions, JSONL, one line per POST with a timestamp. Committed plainly — a full match is a few MB and the diffs are reviewable. Recorded by tools/gsi-record, replayed by FakeGsiSource and tools/gsi-replay.

**A match Riki played is a fixture in this format.** The recorder writes `<dataDir>/matches/<matchId>.jsonl`, and every line — including its header and its 30-second `WorldState` keyframes — is a valid `GsiFixtureLine`, so a recording can be dropped in here and replayed with no conversion (ADR-0044). The keyframe lines carry `body: {}`, which is what makes a fixture reader step over them; do not "tidy" that field away. A recording cut short by a crash needs its partial last line dropped first — `parseGsiFixture` calls `JSON.parse` per line with no guard, where `parseRecordLines` tolerates the tail.

## `console-log/`

Captured Dota console.log excerpts, including a rotation boundary. Scrub anything you would not want committed: these contain chat.

## `frames/`

Hand-labelled screenshots plus label JSON, stored in git-lfs (see .gitattributes). Grow this corpus deliberately, weighted toward hard frames — chaotic teamfights, not clean laning. Tests that need frames skip with a clear message when the LFS objects are absent.

`synthetic/` is the exception: small hand-generated `.ppm` frames, committed plainly because .gitattributes puts only `*.png`/`*.jpg`/`*.jpeg`/`*.webp` in LFS. They are not screenshots and prove nothing about recognition accuracy — they exist so `riki-vision --backend replay --frames fixtures/frames/synthetic` can drive the real capture pipeline on a machine with no display. PPM because it needs no decoder in the shipped binary.

## `vision/`

Scripted sidecar sessions, JSONL, one `VisionStep` per line, replayed by `FakeVisionSidecar`. Each line's `event` is a literal `SidecarEvent` — the same bytes `crates/riki-vision` writes — rather than a compressed notation a builder expands, so the fixture keeps agreeing with the protocol only while it really does.

Distinct from `frames/`, and the difference is the point: a frame exercises the *capture* pipeline in Rust, and a vision script exercises everything *after* it in TypeScript. Nothing here is captured — no machine in this project can capture a Dota window (ADR-0033, ADR-0035) — so the hero sightings are the shape a detector is specified to produce. Each file's header says what a real recording would settle.

## `realtime/`

Recorded Realtime event transcripts, replayed by FakeRealtimeTransport. No live session is ever required by a test.

## `golden/`

Expected snapshot-renderer output. The format is the interface to the LLM, so changes show up here as a readable diff.

## `protocol/`

The shared corpus both languages parse in the Tier 3 contract test: TS encodes → Rust decodes → Rust re-encodes → TS decodes → deep-equal.

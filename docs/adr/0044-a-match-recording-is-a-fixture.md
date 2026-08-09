# ADR-0044: A match recording is a fixture, and the world model writes it

**Status:** Accepted
**Date:** 2026-08-09

Implements the dataset half of
[conversational-architecture.md](../design/conversational-architecture.md) §6 —
[ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md)'s replacement memory.
T6's `world_at` and T11's replay harness both read what this decides.

## Context

Riki's memory of a match had to move out of the process. The five-minute ring in
`history/ring.ts` is right for the live path and useless for "what was their net worth ten minutes
ago", and 2026-08-09's debugging session cost a morning for the want of a recording of the match
that broke.

Two things had to be settled before a byte could be written.

**What the file looks like.** `fixtures/gsi/*.jsonl` already exists, `FakeGsiSource` already reads
it, and `pnpm dev:replay` already drives the whole app from it. A recording in a *second* format
would mean a played match was a dataset and not a test case, and the design doc's first argument for
disk over memory is precisely that every match played becomes a replayable fixture. But a recording
is not only GSI POSTs — it carries log and CV observations, and a serialised `WorldState` every
30 seconds — and `parseGsiFixture` does not know what any of those are.

**Where the code lives.** `packages/world-model`'s header has said "pure functions over data: no
I/O" since it was scaffolded, and the recorder writes files. The three consumers that need these
bytes — the app, the timeline reader behind `world_at`, and `tools/` — are in three different
places, so "put the I/O in each caller" means three implementations of one format.

## Decision

**Every line of a recording is a valid `GsiFixtureLine`.** `atMs` and `body` are mandatory on all of
them; a GSI observation puts the raw POST in `body` and its envelope (`sourceId`, `seq`,
`receivedAt`, `v`, and the game clock) alongside, and the header and keyframe lines carry
`body: {}`. An empty object is a well-formed POST that observes nothing, so a fixture reader steps
over them and fuses nothing.

**The recorder lives in `packages/world-model/src/record/`, and exactly one file in it does I/O.**
The recorder, the line format and the keyframe encoder are pure over an injected `RecordSink`;
`record/file-sink.ts` holds the descriptor and is the only place in the package that imports
`node:fs`. The composition root supplies the sink factory, which is what keeps the path — and
`app.getPath('userData')` — outside the package.

**A keyframe is `flattenFacts`, not the object graph:** a flat `FieldPath → Fact` map plus the
version and `lastUpdatedAt`, read back as `emptyState` plus one `writeFact` per entry.

**Writes are unbuffered.** `writeSync` per line, in a loop until the bytes are gone. `close()`
closes a descriptor; there is nothing left to flush by the time it is called.

## Consequences

- A recorded match replays through `FakeGsiSource` and `tools/gsi-replay` with no conversion step,
  and `apps/desktop/src/main/state/recording.test.ts` asserts it by replaying a fixture into a file
  and then replaying that file.
- A keyframe round-trips **by construction**. Every leaf the model can hold is reachable by a
  `FieldPath`, so a field added to `WorldState` is carried with no change to the encoder — where a
  bespoke encoder would silently stop recording it.
- A `SIGKILL` mid-match costs the half-written last line and nothing else. `parseRecordLines`
  reports a truncated tail rather than throwing, and distinguishes it from corruption in the middle.
  **`parseGsiFixture` does not**: it calls `JSON.parse` per line with no guard, so a *crash-truncated*
  recording is not directly replayable until the partial line is dropped. A cleanly closed one is.
- The package's purity claim is now "pure except one named file", which is weaker than "pure". It is
  written into the package header so the next reader meets it before they meet the import.
- `body: {}` is a real cost: a replay of a recording delivers one inert observation per keyframe. It
  fuses nothing and changes no version, but it is not free, and a reader counting observations in a
  replayed recording has to know.
- Two things a keyframe deliberately does not carry: the delta ring, because the recording *is* the
  history, and the chat ring, because dota2 §7 classes chat `sensitive` and a local file is one
  upload away from being egress. Chat *log events* are still recorded — that somebody spoke at this
  instant is a fact about the match — with the text and speaker removed and `redacted: true` on the
  line.
- `player.steamid` reaches the file unhashed. dota2 §7 requires it hashed and T10 owns it; this is
  the seam it lands on, and it is a gap until then.

## Alternatives rejected

**A second format, converted on the way to a fixture.** Cleaner lines, and it gives up the property
the whole design is for: a match you played is a test case with no step in between. The conversion
would also be a fourth place that knows the format.

**Omitting `body` on non-observation lines.** This is the trap, and it looks like the obvious choice.
`parseGsiFixture` falls back to `parsed.body ?? parsed`, and `createGsiPayloadParser` accepts any
object and files what it does not recognise under `unknown` — so a keyframe with no `body` replays
as a POST whose `unknown` holds the entire serialised world. Nothing errors. A test that asserts
only "the parse succeeded" passes, because every object parses.

**Keyframes in `//` comment lines.** `parseGsiFixture` skips those, which would make them free. It
also stops the file being JSONL, and hides the largest thing in it from every tool that reads JSON.

**A `WriteStream`.** The ergonomic choice, and it reintroduces exactly the failure this replaces: a
userspace buffer means a killed process loses the last seconds of the match, which is the part
somebody is asking about.

**The file sink in the composition root.** Keeps `packages/world-model` pure. Costs a second
implementation in `tools/` and a third wherever `world_at` reads from, and the format is then
defined by whichever of the three is being read.

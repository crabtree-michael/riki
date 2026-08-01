# Realtime session fixtures

Recorded server-event transcripts, one raw wire JSON object per line, loaded through
`parseServerEvent` and replayed by `FakeRealtimeTransport.play()` from `@riki/realtime/testing`.

**No test may open a live session** (REPO_SKELETON.md §5.2, §7.1). These files are what stands in
for one, and `pnpm dev:replay` drives the app through the same fake, which is what keeps them
honest.

## The corpus

`REQUIRED_FIXTURES` in `@riki/realtime/testing` names the set, and
`packages/realtime/test/fixtures.test.ts` asserts every one of them exists and parses — so a
missing recording fails there rather than surprising someone three tasks later.

| File | What it exercises |
| --- | --- |
| `ptt-turn.jsonl` | One push-to-talk turn: commit, both transcripts, usage |
| `barge-in.jsonl` | `speech_started` with the gate shut — self-interruption, and a truncated transcript |
| `tool-call-with-consent.jsonl` | `read_screen`, the one command with an effect outside this process |
| `mid-response-disconnect.jsonl` | A turn that never ends. The hung-session shape (research §11.3) |
| `context-exhaustion.jsonl` | The API truncating before we did — a bug, not a condition (context §6) |
| `long-session-25min.jsonl` | 75 turns at one per 20 s, for cost and cached-fraction accounting |
| `beta-schema-session.jsonl` | Beta event names. Exists to prove we detect them (research §3) |

## Conventions

- **Raw wire JSON, not `ServerEvent`.** A recording is what came off the socket; parsing is the
  thing under test. `loadFixture` maps each line through `parseServerEvent`.
- **GA event names only.** `response.output_audio_transcript.done`, not
  `response.audio_transcript.done`. The beta names appear in exactly one file, and a test asserts
  they appear in no other.
- **No audio payloads.** Under WebRTC the audio rides the media track and never appears as an
  event at all (research §2), so a fixture carrying base64 would be recording a shape the default
  transport never produces. Playback is measured from the signal instead — `packages/audio`'s
  `PlaybackTracker`.
- **No timing.** `play()` replays synchronously and tests inject their own clock. A fixture that
  encoded wall-clock timing would make every test that reads it slow and flaky, and the ordering
  is what these tests actually assert.

## Adding one

Record from a real session, then hand-trim to the events under test. Redact before committing:
transcripts contain the developer's own voice, and `session.created` can carry a session id. There
is no key material in a server event — the ephemeral secret never appears in one — but check anyway.

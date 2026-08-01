# Realtime session fixtures

Recorded server-event transcripts, one JSON object per line, replayed by
`FakeRealtimeTransport.replay()` from `@riki/realtime/testing`.

**No test may open a live session** (REPO_SKELETON.md §5.2, §7.1). These files are what stands in
for one, and `pnpm dev:replay` drives the app through the same fake, which is what keeps them
honest.

## What is here

| File | Shape |
| --- | --- |
| `ptt-turn.jsonl` | One push-to-talk turn: user speaks, model answers, usage reported |
| `ptt-turn-with-tool-call.jsonl` | The same, but the model calls `get_timings` first |
| `barge-in.jsonl` | The model starts a long answer; the caller interrupts partway |
| `beta-schema-session.jsonl` | A session misconfigured with the beta schema (research §3) |

## Conventions

- **GA event names only.** `response.output_audio.delta`, not `response.audio.delta` — the beta
  names appear in exactly one file, `beta-schema-session.jsonl`, and that file exists to prove
  we detect them.
- **Audio deltas carry filler base64**, not real samples. Only the length is read, for playback
  accounting; the samples themselves ride the WebRTC media track in production.
- **Timing is not recorded.** The transport replays synchronously and tests inject their own
  clock (`FakeClock`), because a fixture that encoded wall-clock timing would make every test
  that reads it slow and flaky.

## Adding one

Recorded from a real session, hand-trimmed to the events under test. Redact before committing:
transcripts contain the developer's own voice, and `session.created` carries a session id. There
is no key material in a server event, but check anyway.

---
name: voice-realtime
description: The OpenAI Realtime session and the audio path — `packages/realtime` and `packages/audio`. Covers the beta-versus-GA schema trap, 48k/24k resampling, barge-in truncation, context growth over a long match, echo cancellation, ducking and cost. Use when touching the Realtime session, transport, turn-taking, microphone or speaker path.
---

# Voice: the Realtime session and the audio path

The Realtime API is an async event bus, not a request/response call. Most bugs here present
as a hung session rather than an error, which is why `no-floating-promises` is an error in
this repo.

## Traps that have already been documented

- **Beta and GA schemas mix silently.** A `session.update` carrying a top-level `voice` or a
  string `input_audio_format` is the beta shape; it will not error, it will misconfigure the
  session. Assert the outgoing payload against the GA schema and snapshot it.
- **Resampling failures sound like a working system.** Wrong 48 kHz ↔ 24 kHz conversion
  produces pitch-shifted audio, not an exception. Round-trip a known tone and assert the
  frequency.
- **Barge-in without `conversation.item.truncate` corrupts every later turn.** When the user
  interrupts, send the truncate with a plausible `audio_end_ms`. The model's idea of what it
  said must match what the user actually heard.
- **Context fills in 15–20 minutes** and the default truncation is oldest-first, which busts
  the prompt cache. A Dota match is 35–45 minutes. Have a retention policy, and test it
  against a simulated 25-minute session.
- **Echo cancellation is mandatory.** Without AEC the model hears itself and self-interrupts
  in a loop. This is the reason the shell is Electron with bundled Chromium.

## Audio

Duck game audio rather than pausing it. Earcons carry state for players who are not looking
at the overlay — they are part of the state model, not decoration. Mic level drives the
chip's bars, so the envelope math is on the UI hot path; keep it cheap and unit-test it.

## Keys and cost

- `packages/realtime` **receives the API key injected** from `packages/config`. It must
  never read `process.env` itself — a lint boundary enforces this.
- **No test may open a live session.** `FakeRealtimeTransport` replays
  `fixtures/realtime/*` and records what we sent. Anything that costs money is not in CI.
- The model choice is the main cost lever; the mini model is the default for a reason. Cost
  accounting lives in this package — keep it, it is how the lever stays visible.

## Learnings

*(nothing yet — the first agent to learn something here adds the first entry)*

## See also

`docs/openai-realtime-research.md` §3 (formats and the schema trap), §4 (turn-taking
and barge-in), §5 (context), §10 (costs), §11 (gotchas for games);
`REPO_SKELETON.md` §5.4, §7.1 (the key).

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

**Ducking does not work on macOS, and macOS is primary.** There is no public API for
attenuating another application's audio (ADR-0015, ADR-0016). The no-op path is the *default*,
and a sink that cannot duck is a correct sink: no fault, no log, no retry. Do not "fix" it —
read `docs/research/audio-ducking-platform-support.md` first.

Earcons carry state for players who are not looking at the overlay — they are part of the state
model, not decoration. Mic level drives the chip's bars, so the envelope math is on the UI hot
path; keep it cheap and unit-test it.

## Keys and cost

- `packages/realtime` **receives the API key injected** from `packages/config`. It must
  never read `process.env` itself — a lint boundary enforces this.
- **No test may open a live session.** `FakeRealtimeTransport` replays
  `fixtures/realtime/*` and records what we sent. Anything that costs money is not in CI.
- The model choice is the main cost lever; the mini model is the default for a reason. Cost
  accounting lives in this package — keep it, it is how the lever stays visible.

## Learnings

**2026-08-01 — Barge-in truncation is manual on WebRTC too, and the reason is two ADRs
interacting.** The research note (§4) says WebRTC handles barge-in server-side, "nothing to do".
That is true *only when server VAD is running*. ADR-0004 sets `turn_detection: null`, so there is
no VAD, so the server cannot see an interruption that only the hotkey knows about. Every
transport needs the manual `conversation.item.truncate`.

**2026-08-01 — and worse: `response.output_audio.delta` never arrives on WebRTC at all.** Audio
rides the media track (research §2), so a playback tracker keyed only off audio deltas passes
every websocket test and then silently never truncates in production — the exact failure the
truncate exists to prevent. Start playback accounting on an assistant *transcript* delta as well.
Found only because a replayed fixture disagreed with a unit test. *Why:* the two `response.*`
event families behave differently per transport, and nothing in the docs says so.

**2026-08-01 — do not copy §5's `retention_ratio: 0.8` into your own compaction policy.** That
number is the *API's*, and the API's trigger is the window being genuinely full, so it leaves 20 %
headroom. A local policy that triggers at 90 % and retains 0.8 leaves 10 % and compacts about
twice as often — ~10 times per 45-minute match instead of ~5, each one re-paying full price
against an 80× cached discount. They are different knobs; do not forward one into the other.
`packages/realtime` uses 0.6 locally. *(tunable, measured against a simulated match, not live.)*

**2026-08-01 — `noUncheckedIndexedAccess` applies to typed arrays, and `!` is banned in `src/`.**
Every `Float32Array[i]` is `number | undefined`, and `no-non-null-assertion` is only relaxed in
tests. Use `?? 0` in DSP loops, or `for…of` where you do not need the index — `prefer-for-of`
will make you do the latter anyway. Costs ten minutes if you discover it after writing the filter.

**2026-08-01 — make the API key a class, not a string.** The `process.env` lint boundary stops
the *deliberate* leak; it does nothing about `JSON.stringify(deps)` in a telemetry call or a key
interpolated into an error message. `ApiKey` in `auth/credentials.ts` redacts through `toString`,
`toJSON` **and** `Symbol.for('nodejs.util.inspect.custom')` — that third one is what `console.log`
actually uses in main, and `toString` does not cover it.

**2026-08-01 — the naive DFT in `@riki/audio/testing` is O(n²); bound the window.** A 250 ms
frequency assertion at 48 kHz took 3.7 s on its own. 4096 samples still resolves a clean tone to
well under a hertz after parabolic interpolation, and brings the whole file to ~1 s. Tier 1 is
supposed to be milliseconds.

## See also

**There is no voice design document** — the decomposition lives in
`docs/adr/0017-voice-input-module-decomposition.md`, which is the thing to read first.

`docs/research/openai-realtime-research.md` §3 (formats and the schema trap), §4 (turn-taking
and barge-in), §5 (context), §10 (costs), §11 (gotchas for games);
`docs/research/audio-ducking-platform-support.md` (why ducking is a no-op);
ADR-0004 (push-to-talk), ADR-0010 (the voice window), ADR-0015/0016 (macOS, ducking);
`REPO_SKELETON.md` §5.4, §7.1 (the key).

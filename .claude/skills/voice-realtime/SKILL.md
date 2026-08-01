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

**Ducking is a no-op on macOS, which is the primary target** — there is no public API for it
(ADR-0020). `createNoopDucker()` is the default path, not a fallback, and it stays silent. Never
pause game audio as a substitute; that needs the same absent API and is worse.

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

**2026-08-01 — Under WebRTC, half the things this skill lists are not on the default path.** The
research note is written transport-agnostically and the repo docs inherited that. Concretely:
resampling does not run at all (Chromium encodes Opus; the 48k↔24k code is the WebSocket path and
the fixtures), and barge-in truncation is server-side *while VAD is on* — see the next entry.
*Why:* an agent who reads "packages/audio owns resampling" and starts building a streaming
pipeline has built the WebSocket product. Check which transport a responsibility belongs to before
you implement it; `docs/design/voice-input-architecture.md` §4.1 is the table.

**2026-08-01 — `turn_detection: null` is the textbook push-to-talk setting and probably the wrong
one here.** Server-side barge-in truncation is a VAD feature, so turning detection off plausibly
takes it with it — which hands back the manual `conversation.item.truncate` dance that WebRTC was
chosen to avoid. Riki uses `server_vad` with `create_response: false` instead (ADR-0017): the
gesture still owns when a response happens, and the gate (ADR-0016) means VAD only ever sees audio
the player deliberately sent. The cost is a commit race — with VAD on, the buffer commits when the
server sees speech *stop*, so `response.create` on key release can outrun the tail of the
utterance. Wait for `speech_stopped` with a bounded grace. *Why:* both halves of this are silent
failures — one loses truncation, the other truncates the player's last three words.

**2026-08-01 — `Esc`-cancel needs a truncate even on WebRTC.** The server truncates when *it* sees
the user interrupt. A cancel with no speech behind it (Esc, a local "stop") never triggers that, so
`response.cancel` alone leaves the model believing it finished a sentence the player cut off. Send
the truncate yourself in that case, and only that case — sending both on a real barge-in truncates
twice at two different offsets.

**2026-08-01 — `connect()` returning `Promise<void>` and *throwing* is not the same thing.**
The WebSocket transport validated its media argument before the first `await`, so a wrong-media
call threw synchronously and escaped the caller's `.catch()` entirely — surfacing somewhere
unrelated, or not at all. Mark any method whose signature promises a promise `async`, even when
the body has nothing to await; the rejection path is part of the contract.

**2026-08-01 — a short command word cannot be fuzzy-matched, and the arithmetic says why.**
`parseLocalCommand` first used normalised edit distance with a per-command threshold. At four
characters one edit is a 0.75 ratio, and "stomp" is one edit from "stop" — so any threshold loose
enough to accept a real mistranscription ("shuddup" is two edits over seven) is loose enough to
mute the player for saying a different short word. The fix is a tolerance in *edits* scaled by
length — none below five characters, one per five thereafter — and putting genuine phonetic
variants in the phrase table instead. *Why:* the failure mode of a false positive here is Riki
muting itself mid-fight, and the fuzzy matcher is exactly where that gets introduced.

**2026-08-01 — measure playback from the signal, never from `response.output_audio.delta`.**
That event does not exist on WebRTC — the audio is on the media track (research §2) — so a
playback tracker keyed off it passes every WebSocket test and then never starts in production,
`audibleMs()` stays zero, and barge-in silently stops truncating on the *default* transport. The
`PlaybackTracker` in `packages/audio/src/playback.ts` analyses the remote track and contains no
wire event at all, which makes the failure unreachable rather than fixed. Start the measurement
from `response.output_item.added`, which arrives everywhere.

**2026-08-01 — the API key is an `ApiKey`, not a `string`** (ADR-0022). The `process.env` lint
boundary stops the deliberate leak; nothing stops `JSON.stringify(deps)` or a key interpolated
into an error message. Redaction has to cover `toString`, `toJSON` **and**
`Symbol.for('nodejs.util.inspect.custom')` — that third one is what `console.log` in main actually
calls, and it is the one people forget.

**2026-08-01 — ducking does not exist on macOS, and macOS is primary.** Settled, with sources, in
`docs/research/audio-ducking-platform-support.md`; the decision is ADR-0020. `duckOthers` is
`API_UNAVAILABLE(macos)`, Core Audio reaches only the default device and our own stream, and every
tool that manages per-app volume installs an audio HAL plug-in. So `createNoopDucker()` is the
**default** path, not a fallback, and it must be *silent* — no fault, no log, no retry, because
speaking over un-ducked game audio is the normal case. *Why:* the instinct on seeing a no-op ducker
is to treat it as unfinished and "fix" it; the fix is a system extension, and it is not worth it.
The live consequence is ui-design §7.2's own rationale, now open question 17.

**2026-08-01 — the credential puzzle has an answer, and it is not "pass the key to the
renderer".** ADR-0002 puts the peer connection in a renderer; §7.1 forbids the key leaving main.
Main mints an ephemeral client secret (`POST /v1/realtime/client_secrets`) and passes only that
across the bridge — ADR-0015. If you find yourself wanting `RIKI_OPENAI_API_KEY` in renderer code,
this is the thing you are missing.

## See also

`docs/design/voice-input-architecture.md` — the architecture for this area: capture, the session,
turn-taking, transcription and command parsing, and the class structure of both packages;
`docs/research/openai-realtime-research.md` §3 (formats and the schema trap), §4 (turn-taking
and barge-in), §5 (context), §10 (costs), §11 (gotchas for games);
`docs/research/audio-ducking-platform-support.md` (why `Ducker.available` is false on macOS);
`REPO_SKELETON.md` §5.4, §7.1 (the key).

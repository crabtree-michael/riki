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

**2026-08-09 — the session dispatches tool calls now, and the dispatcher has nowhere to live yet.**
T4 wired the round trip: `session.update` carries the manifest, `response.function_call_arguments.done`
is parsed, dispatched and answered with a `function_call_output`, and the turn controller sends the
continuation `response.create`. Four things about it that are cheap to say and were not obvious:

- **The manifest is sent only when a `ToolDispatcher` is injected** (ADR-0049). `deps.tools` is
  optional, and its absence is what sends `tools: []`. So if you are looking at a live session and no
  tool is ever called, check that a dispatcher was passed before checking anything else — the two
  states differ by one field on a deps object and are otherwise identical from the outside.
- **Nothing implements the port in production, and it is not an oversight.** The session runs in the
  voice window; the world model runs in main. A real dispatcher is a renderer→main request that
  `schemas/voice.ts` does not have, which is a protocol coordination event. `RealtimeSessionDeps.tools`
  says so, and so does voice-input-architecture.md's protocol-drift list.
- **Every failure answers `{ unknown: reason }` rather than throwing.** That works because every tool
  result is `orUnknown(Report)`, so one encoding is valid for all five — `tools.test.ts` asserts it per
  tool rather than assuming it, and that test is what would fail if a sixth tool were added with a bare
  result. The consequence to hold onto: a completely broken tool layer sounds like a slightly vague
  Riki, so `toolCallRejected` telemetry and ADR-0047's no-call mark are the only things that make it
  visible.
- **`VoiceTelemetry.strayToolCall` is now `toolCallRejected(name, reason)`.** Same signal, honest
  name: under ADR-0023 it counted a call that should never have arrived, and it now counts one that
  arrived and could not be answered. `no-tools` is the old meaning and should still read zero.

*Why:* the one that cost time was none of the above — it was realising that the obvious place to send
the continuation `response.create` (beside the dispatch, in `session.ts`) puts a second producer of it
in the package and quietly breaks ADR-0017. It is `TurnController.submitToolOutput`, which also
suppresses the continuation after an `Esc`: a tool call is the only `await` inside a spoken response,
so it is the only place where "the player said stop" and "we are about to ask for more speech" are both
true. Mutation-tested — deleting that one guard fails a test.

**2026-08-09 — Riki has tools again, and a Realtime tool definition is flat.** ADR-0042 reverses
`tools: []`. The definitions are `{ type, name, description, parameters }` at the top level;
Chat Completions nests those four under a `function` key and that is the form most examples show.
`packages/realtime/src/tools.ts` builds the manifest from the zod schemas in `@riki/protocol` and
`assertRealtimeToolShape` refuses the nested form by name — the same third-layer assertion
`assertGaShape` is for the session payload, because a session that was configured with no usable
tools does not error, it just never calls one, which is indistinguishable from a model choosing not
to. What the API actually does with the nested form is **not measured**; the assertion is there so
nobody finds out mid-match.

Two consequences for anything you write here. The manifest sits in the **cached prefix**, so it is
computed once at session open and never changed mid-session — availability belongs in the *result*
of a call (`{ unknown: reason }`), never in the presence of the tool, which is ADR-0011's surviving
half. And it is charged for on every session whether or not anything calls it, which is why
`TOOL_MANIFEST_BUDGET_CHARACTERS` exists and a test asserts it (1,811 of 3,000 characters today).

**2026-08-04 — the mint's session id moved to `session.id`, and an empty one fails four layers away
as silence.** `parseClientSecret` read `session_id` from the response root or from `client_secret`,
and fell back to `''` when it found neither. The GA response nests the whole session object and
carries the id as `session.id` — verified against a live mint, not read:

```
value = ek_…            expires_at = 1785811753
session.id = sess_E8zLdppJmMk5GEYSW53s4      ← here
```

The `''` then failed `packages/protocol`'s `sessionId: z.string().min(1)` **inside the renderer**,
which rejected the entire `voice.session.open` directive as unreadable. No session was created, and
every later `voice.turn.speak` hit `await live?.session…` in `renderer/voice/host.ts` — optional
chaining — so it silently did nothing and never sent back `responseEnded`. Symptom: the whole
coaching chain works, the inspector shows `spoke:` turns, `agent speaking` sticks on forever
(nothing disarms gate 4), and no sound ever comes out.

`parseClientSecret` now reads all three spellings newest-first and **throws** when it finds none.
That throw is the actual fix: an empty id cannot degrade, because the renderer refuses the message,
so the only outcomes are a working session or a silent match.

*Why:* this cost a day, and none of it was spent near the bug. Two things would have found it in
minutes and both are now in place — the voice telemetry in `main/index.ts` was four no-op arrows, so
the `session-lost` fault reached nothing, and there was no way to drive a coaching flow without an
external script. See ADR-0039 and the `overlay-ui` skill. **When Riki is silent, the first question
is whether a session exists at all** — `lsof -nP -i -a -p <pid>` on the Electron processes answers
it, and one established connection to the Realtime endpoint plus mDNS on `*:5353` is what a live
WebRTC session looks like.

*Second-order:* do not trust a one-second socket poll to prove "the app never touched the network".
The mint is a ~300 ms HTTPS round trip and it hides between samples; it was there all along in a run
I reported as having no network activity at all.

**2026-08-02 — the voice path is wired end to end, and here is where each half lives.** The renderer
is `apps/desktop/src/renderer/voice/`: `host.ts` holds every decision and takes the DOM through
ports, so it is a Tier 1 test; `web-audio.ts`, `media.ts` and `peer.ts` are the three adapters that
name a browser API and contain no logic. Main is `apps/desktop/src/main/voice/`: `session.ts` is a
`CoachingSessionPort` over the bridge, `electron-window.ts` is the only Electron import.
`shell/silent-session.ts` is still there and is still the path with no API key — `main/index.ts`
chooses between them on `voiceEnabled(config)`, and that one line is the entire difference.

**2026-08-02 — `createRealtimeSession` connected with a placeholder track and discarded the remote
one, and both failures are silent.** The scaffolded call passed `outbound: { id: 'outbound' }` and an
empty `onRemoteTrack`, marked as waiting for step 7. Left alone, the session negotiates, the data
channel opens, `session.update` is accepted, every event flows — and the model hears nothing while
`PlaybackTracker.audibleMs()` stays zero, which also stops barge-in truncating. There is now a
`media` field on `RealtimeSessionDeps`; it is optional because `FakeRealtimeTransport` ignores it,
and it is **not** optional in production. If a live session ever appears to connect and then does
nothing, check that first.

**2026-08-02 — main allocates the turn id, and two allocators is a turn that silently never
submits.** `TurnController.beginTurn` now takes an optional `turnId`. It has to: the id is the join
key for the ledger and the coaching memory, `CoachingAgent.beginPlayerTurn` must return one
*synchronously* (the overlay's ≤100 ms budget), and an id allocated in a renderer could only come
back asynchronously. If the renderer allocated its own, `endTurn` would compare it against main's,
find them different, `return` early — and the turn would end with no `response.create` and no error
anywhere.

**2026-08-02 — no `MonoMs` may cross the preload bridge.** Main and a renderer do not share a
`performance.timeOrigin`, so a monotonic timestamp from one is meaningless to the other *and looks
entirely plausible in a log* — it is off by however long that renderer took to start. So
`ClientSecret` crosses as `expiresInMs` (a duration) and level frames carry no timestamp at all;
main stamps them on receipt, which is the clock the overlay's ballistics already use.
`voice-contract.test.ts` asserts this by walking the schema's field names, so a timestamp added
later fails rather than being reviewed.

**2026-08-02 — one telemetry signal has no protocol message and dies at the bridge.**
`VoiceTelemetry.selfInterruption` is the AEC canary — the server reporting speech while our gate is
shut means the model is hearing itself, which is the loop ADR-0001 chose Electron to avoid. It is
counted in the renderer (`VoiceHost.selfInterruptions`) and goes no further, because
`schemas/voice.ts` has no message for it. That is the first thing to add on the next protocol
change, and until then voice-input §13's open question 1 — does Chromium's AEC survive the Web Audio
graph? — cannot be answered from a running app.

**2026-08-02 — level frames need an off switch, and it belongs at the sender.** Overlay §5.5 says
they cross at 30 Hz *while the chip can show bars and not otherwise*, which has no producer unless
something says which. `voice.level.enable` is that, and the drop happens in the renderer rather than
in main so an idle Riki costs zero IPC messages rather than thirty a second that main discards.

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

**2026-08-09 — a port can be implemented on both sides and subscribed by nobody, and it reads as
working.** `PeerConnectionLike.onConnectionStateChange` was in the interface, implemented in
`renderer/voice/peer.ts` against a real `connectionstatechange` listener, and **called from nowhere**.
So `createWebRtcTransport` could only reach `closed` from its own `close()` and from a refused SDP
POST: a peer connection that died mid-match left the transport reporting `open` forever while every
layer above kept sending client events into a channel that was gone. That is half of why the
60-minute expiry on 2026-08-09 went unnoticed — the other half is that nothing was listening for
`transport.onStateChange` in `createRealtimeSession` either.

*Why:* two well-written adapters and an interface that names the thing look exactly like a wired
feature. Before you trust a state signal here, grep for its *subscriber*, not for its declaration.
The same check is worth running on `DataChannelLike` (which still has no `onClose` at all) and on
anything else on that seam.

**2026-08-09 — the session expiry must be classified before the auth check, and `session_expired` is
not `session_lost`.** `faultFor`'s regexes are tried in order, and the expiry code contains neither
`session_lost` nor `connection`, so it used to fall through to `offline` — retryable, but named after
a network problem, which is where anyone reading the log looks first. Matching it as `auth` is worse:
persistent and non-retryable is exactly the shape that stops the renewal supervisor renewing and puts
a permanent error on a chip that has nothing wrong with it. It is `session-lost`, retryable, matched
before auth (ADR-0045).

**2026-08-09 — `SessionSupervisor` in `session.ts` is declared and will stay unimplemented; renewal
is in `apps/desktop/src/main/voice/session.ts`.** If you go looking for rotation where the interface
is, this is the missing line: a new session needs a fresh client secret, minting needs the `ApiKey`,
and the key is in main (ADR-0015) — the voice window's `CredentialPort.acquire()` resolves the
constant it was handed and has nothing to mint with. Main renews by minting and sending
`voice.session.open` again; the renderer's handler already closes the live session before opening the
new one, so rotation needed no new message and no protocol change. Moving it down means adding a
renderer→main *credential request* to `schemas/voice.ts`, which is a coordination event.

**2026-08-09 — an expiry arrives twice, and an orderly close looks identical to it.** The API sends
`session_expired` *and* drops the connection, in either order, so anything that reacts to a lost
session needs to collapse them — two reactions means renewing a session that was only lost once. And
the mirror of that: `transport.close()` and `peer.close()` both drive the state to `closed`, so
without a "we asked for this" flag every renewal raises the fault that triggers a renewal. Both
guards are in `createRealtimeSession`; `FakeRealtimeTransport.expireSession(order)` reproduces the
pair either way round.

## See also

`docs/design/voice-input-architecture.md` — the architecture for this area: capture, the session,
turn-taking, transcription and command parsing, and the class structure of both packages;
`docs/research/openai-realtime-research.md` §3 (formats and the schema trap), §4 (turn-taking
and barge-in), §5 (context), §10 (costs), §11 (gotchas for games);
`docs/research/audio-ducking-platform-support.md` (why `Ducker.available` is false on macOS);
`REPO_SKELETON.md` §5.4, §7.1 (the key).

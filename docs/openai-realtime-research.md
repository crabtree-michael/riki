# OpenAI Realtime API — Research Notes

**Researched:** 2026-08-01
**Status:** Research only. No integration decision made, no code in this repo yet.

> **Scope note:** the brief asked about "the newly released" Realtime API. The API is
> not new — it launched in preview October 2024 and went GA in August 2025 with
> `gpt-realtime`. What *is* recent is the **`gpt-realtime-2.1` / `gpt-realtime-2.1-mini`**
> generation (July 2026), which added reasoning to the mini tier and cut p95 latency
> ~25%. Notes below target the GA (2.1) interface. If you find a tutorial using
> `input_audio_format` as a bare string or a top-level `voice` field, it is written
> against the **beta** schema and will silently misconfigure a GA session — see
> [Beta → GA schema trap](#beta--ga-schema-trap).

---

## 1. What it is

A single stateful session that takes **speech in** and produces **speech out** with one
model, rather than chaining STT → LLM → TTS. The model hears the raw audio, so prosody,
interruptions, and non-verbal cues survive the round trip, and you save two network hops
of latency. It also does text, image input, and function calling in the same session.

The interaction model is an **event bus**, not request/response. You send client events
(`session.update`, `input_audio_buffer.append`, `response.create`) and subscribe to server
events (`response.output_audio.delta`, `input_audio_buffer.speech_started`, …). Everything
is asynchronous and interleaved.

### Models

| Model | Audio in | Audio out | Notes |
|---|---|---|---|
| `gpt-realtime-2.1` | $32 /M tok | $64 /M tok | Flagship. Best alphanumeric recognition (spelling out codes, IDs), noise handling, interruption behavior. |
| `gpt-realtime-2.1-mini` | $10 /M tok | $20 /M tok | Distilled reasoning model. ~⅓ the audio cost. Weaker instruction-following. |
| `gpt-realtime` (`-2025-08-28`) | $32 /M tok | $64 /M tok | Original GA snapshot. Still pinned by a lot of existing code. |

Shared limits for the `gpt-realtime` family:

- **Context window: 32,768 tokens** — small. Max output 4,096, so practical input ceiling
  is **28,672 tokens**. Session instructions + tool definitions are capped at 16,384.
- **Max session duration: 60 minutes** (raised from 30).
- **Knowledge cutoff: October 2023.** Anything world-recent must come in via tools or context.

> ⚠️ Several third-party blog posts still cite a 128k context window for the Realtime API.
> That is wrong for the current models — OpenAI's own model page and developer notes both
> say 32k. Budget accordingly; see [context](#5-context-management-the-real-constraint).

---

## 2. Transports

Three options. **The choice is mostly about where your audio physically lives.**

### WebRTC — client captures/plays audio directly

Recommended for browsers, mobile, and (by extension) desktop apps that own a microphone.
Handles jitter buffering, packet loss concealment, echo cancellation, and adaptive bitrate
for you — all of which you would otherwise hand-roll badly.

Flow:

1. **Your server** mints an ephemeral client secret with your real API key:

```javascript
// server — never ship the real API key to the client
const sessionConfig = JSON.stringify({
  session: {
    type: "realtime",
    model: "gpt-realtime-2.1",
    audio: { output: { voice: "marin" } },
  },
});

const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Safety-Identifier": "hashed-user-id",
  },
  body: sessionConfig,
});
```

2. **Client** fetches that token, then POSTs an SDP offer to the calls endpoint:

```javascript
const { value: EPHEMERAL_KEY } = await (await fetch("/token")).json();

const pc = new RTCPeerConnection();

// remote audio: just attach the track, WebRTC handles playback
const audioEl = document.createElement("audio");
audioEl.autoplay = true;
pc.ontrack = (e) => (audioEl.srcObject = e.streams[0]);

// local mic
const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
pc.addTrack(ms.getTracks()[0]);

// control plane — client/server events ride this channel
const dc = pc.createDataChannel("oai-events");

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
  method: "POST",
  body: offer.sdp,
  headers: {
    Authorization: `Bearer ${EPHEMERAL_KEY}`,
    "Content-Type": "application/sdp",
  },
});

await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
```

The data channel **must** be named `oai-events`. Audio never touches the data channel —
it rides the media tracks.

### WebSocket — server already holds the audio

```
wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1
Authorization: Bearer <API_KEY>
OpenAI-Safety-Identifier: <hashed-user-id>
```

Audio goes in as base64 chunks via `input_audio_buffer.append` and comes back as
`response.output_audio.delta`. **Explicitly not recommended for live audio capture** —
TCP head-of-line blocking means one lost packet stalls the stream, and you inherit
responsibility for jitter buffering and playback scheduling.

Use it when audio arrives at your backend from a media pipeline or call system, or for
server-side agent orchestration.

### SIP — telephony

Not relevant here. Noted for completeness; verify model compatibility before using it for
translation/transcription sessions.

---

## 3. Audio formats

| Format | Config value | Rate |
|---|---|---|
| PCM16 (default) | `{"type": "audio/pcm", "rate": 24000}` | 24 kHz, mono, 16-bit **little-endian** |
| G.711 µ-law | `{"type": "audio/pcmu"}` | 8 kHz |
| G.711 A-law | `{"type": "audio/pcma"}` | 8 kHz |

PCM only supports 24 kHz. If your engine's audio graph runs at 44.1/48 kHz — which it
almost certainly does — you need resampling on both legs. Getting this wrong produces
audio that plays at the wrong pitch/speed rather than failing loudly, so it is worth a
unit test.

### Beta → GA schema trap

This is the single most common integration failure, worth calling out separately:

```jsonc
// BETA (old tutorials, still parses, silently wrong)
{ "voice": "alloy", "input_audio_format": "pcm16" }

// GA (correct)
{
  "type": "realtime",
  "model": "gpt-realtime-2.1",
  "audio": {
    "input":  { "format": { "type": "audio/pcm", "rate": 24000 } },
    "output": { "format": { "type": "audio/pcm", "rate": 24000 }, "voice": "marin" }
  }
}
```

Mixing the two is worse than using either. There is a known bug in `openai-agents-js`
([#495](https://github.com/openai/openai-agents-js/issues/495)) where including a
top-level `voice` field causes GA-specific `audio.*` settings to be **discarded** and the
session to fall back to legacy defaults. Pick one schema; do not interleave.

---

## 4. Turn-taking, VAD, and interruption

`session.audio.input.turn_detection`:

- **`server_vad`** — energy-based. Fires a response when speech stops. Tunable silence
  threshold. Default.
- **`semantic_vad`** — a model estimates whether the user has *semantically* finished a
  thought. Better for hesitant speakers, costs a bit more latency.
- **`null`** — disabled. You trigger `response.create` yourself. **This is push-to-talk.**

Middle ground worth knowing: keep VAD active for speech detection but set
`turn_detection.create_response: false` and `interrupt_response: false`. You still get
`speech_started` / `speech_stopped` events for UI state, but nothing generates without an
explicit `response.create`. This is the right shape if you need to gate on game state,
run moderation, or inject RAG context before the model speaks.

`session.audio.input.noise_reduction`: `near_field` (headset, close mic), `far_field`
(laptop mic, room), or `null`.

### Barge-in

- **WebRTC:** handled server-side. Output buffer is truncated automatically when the user
  interrupts. Nothing to do.
- **WebSocket:** manual, and easy to get wrong:
  1. Watch for `input_audio_buffer.speech_started`.
  2. Stop playback immediately.
  3. Record **how many ms you actually played**.
  4. Send `conversation.item.truncate` with the item ID and `audio_end_ms`.

Skipping step 4 leaves the model believing it said things the user never heard, and every
subsequent turn is built on that false premise. This is a strong argument for WebRTC in a
client app.

---

## 5. Context management — the real constraint

32k of context, where **assistant audio burns 1,200 tokens per minute** and user audio
burns 600, means a naive session hits the ceiling in roughly **15–20 minutes of continuous
conversation**. This, not the 60-minute cap, is the binding limit.

When it fills, the API **truncates oldest-first**. It does not summarize or compact —
dropped turns are simply gone.

Truncation controls:

- `truncation: "disabled"` — error instead of silently dropping context. Useful in dev to
  find out you have a problem.
- `retention_ratio: 0.8` — on truncation, cut down to 80% of the window instead of
  trimming just enough. Counterintuitive but recommended: **every truncation busts the
  prompt cache**, because changing the head of the conversation invalidates everything
  after it. Trimming aggressively but rarely is much cheaper than trimming minimally but
  constantly.

For long-lived sessions, OpenAI's own cookbook pattern is to periodically replace old
turns with a summary item yourself rather than relying on truncation.

---

## 6. Authentication and rate limits

**Auth:** standard API key server-side only. For any client, mint an ephemeral secret at
`POST /v1/realtime/client_secrets` and hand that to the client. Set
`OpenAI-Safety-Identifier` to a stable hashed user ID **from your backend** — a
client-supplied value is worthless for abuse attribution.

**Rate limits** (`gpt-realtime`):

| Tier | RPM | TPM |
|---|---|---|
| 1 | 200 | 40,000 |
| 2 | 400 | 200,000 |
| 3 | 5,000 | 800,000 |
| 4 | 10,000 | 4,000,000 |
| 5 | 20,000 | 15,000,000 |

`rate_limits.updated` server events report remaining budget mid-session.

⚠️ **Concurrent-session limits are enforced per usage tier but are not published.** For
anything with real concurrency you need to talk to OpenAI before launch rather than
discover the ceiling in production. Note also how quickly TPM binds: at ~1,800 tokens/min
per active conversation, Tier 1's 40k TPM is roughly **22 simultaneous conversations**.

---

## 7. Latency

Numbers in circulation differ by an order of magnitude because they measure different
things. Keep these separate:

| Measure | Value | What it means |
|---|---|---|
| **Machine latency** (OpenAI, single-turn) | ~190 ms | Model-side generation start. Marketing number. |
| Third-party A/B, 2.1-mini, G.711, us-east | ~210–230 ms | Independent, roughly corroborates the above. |
| **End-to-end response latency** (webrtcHacks, Jan 2025, WebRTC) | **1.7–1.9 s** | Measured from RTP packet captures — user stops speaking → first audio out. |
| Median conversational turn latency, medium calls | ~2.24 s (max 4.05 s) | Third-party production observation. |

The gap between 190 ms and 1.8 s is **mostly VAD silence threshold plus inference**, not
network — webrtcHacks measured STUN RTT at only 60–70 ms. The webrtcHacks figure is from
January 2025 and predates both `gpt-realtime` GA and the 2.1 latency work, so today's
real number is lower; I did not find an equally rigorous 2026 re-measurement. **Treat
~1–1.5 s perceived turnaround as the planning assumption and validate it yourself on your
own audio path** — do not plan against 190 ms.

Reducing it: `reasoning.effort: "low"` is OpenAI's recommended production starting point,
tighten the VAD silence threshold, and prefer WebRTC.

---

## 8. SDKs

| SDK | Transport | Notes |
|---|---|---|
| [`openai-agents-js`](https://github.com/openai/openai-agents-js) (TypeScript) | WebRTC **and** WebSocket | `RealtimeAgent` / `RealtimeSession`. Handles interruption, history, tools, handoffs, guardrails. Best fit for an Electron/Tauri renderer. |
| [`openai-agents-python`](https://openai.github.io/openai-agents-python/realtime/quickstart/) | WebSocket only | **No browser WebRTC transport.** Server-side sessions only. |
| `openai-node` / `openai-python` | raw | Lower-level realtime clients. |
| [`openai-realtime-agents`](https://github.com/openai/openai-realtime-agents) | — | Reference app for agentic patterns. Good source of working code. |

**There is no official Unity or C# SDK.** Azure OpenAI exposes the same GPT Realtime
models with its own .NET tooling, which is the practical route for a C#/Unity codebase.
Otherwise it's raw WebSocket against the documented event schema, or a native WebRTC
stack (libwebrtc, Pion, `webrtc-rs`) with hand-written SDP negotiation.

---

## 9. Desktop integration notes

`riki` currently has no application code, so this is stack-independent. The transport
decision follows from the shell:

- **Electron / Tauri with a web renderer** — easiest path by a wide margin. `getUserMedia`
  + `RTCPeerConnection` work as documented; browser echo cancellation and noise
  suppression are already wired up; `openai-agents-js` handles the event plumbing. Mint
  ephemeral tokens in the main process, never the renderer.
  - Tauri caveat: mic access goes through the platform webview (WKWebView / WebView2 /
    WebKitGTK), so permissions and echo-cancellation quality vary by OS in a way Electron's
    bundled Chromium does not.
- **Native (Rust / C++ / C#)** — you own resampling to 24 kHz mono, echo cancellation,
  and either a native WebRTC stack or WebSocket + manual jitter buffering and manual
  `conversation.item.truncate` on barge-in. Meaningfully more work.

Either way: the API key stays on a backend. Shipping it in a desktop binary means shipping
it to anyone with a hex editor. That implies riki needs a token-minting service even if it
otherwise has no backend — a real architectural cost to weigh.

Given the README ("invisible until needed"), push-to-talk or hotkey-gated capture —
`turn_detection: null` — is probably the right default. It also happens to be the single
biggest cost lever, since an always-open mic bills continuously.

---

## 10. Costs

Billed in **tokens, not minutes**:

- User audio: 1 token / 100 ms → **~600 tokens/min**
- Assistant audio: 1 token / 50 ms → **~1,200 tokens/min**

At flagship rates (`$32`/M in, `$64`/M out), a balanced conversational minute is roughly
**$0.10/min**, and third-party measurements put typical uncached agents at **$0.18–$0.46/min**
once you include accumulated context replay on every turn. With prompt caching working and
tool outputs trimmed, that reportedly falls to **$0.05–$0.10/min**. Mini is roughly ⅓.

Cached audio input is **$0.40/M vs $32/M — an 80× discount**, so cache behavior dominates
the bill. This is why `retention_ratio` matters so much: frequent small truncations
repeatedly bust the cache and quietly multiply cost.

You are not billed for silence — server VAD filters non-speech.

Sanity check for a game: at ~$0.10/min, a player talking to NPCs for 30 min/session costs
**~$3/session** on the flagship model. That is not a rounding error against a $30–70 game
price. Mini plus push-to-talk plus short sessions is the difference between viable and not.

---

## 11. Gotchas, especially for games

**Structural**

1. **Cost scales with engagement.** The more a player enjoys the feature, the more it
   costs. There is no cap short of one you build. Per-user budgets are not optional.
2. **Undisclosed concurrency ceilings.** A launch spike can hit a limit you were never
   told about. Load-test and get limits raised in advance.
3. **Hard dependency on network + OpenAI uptime.** The community bug tracker shows
   recurring "Realtime API not responding" and tool-call server-error periods. A game
   needs a scripted-dialogue fallback path, not an error dialog.
4. **Latency floor is conversational, not interactive.** ~1–2 s is fine for a shopkeeper.
   It is not fine for combat callouts or anything on the frame loop.

**Behavioral**

5. **The model can hear itself and interrupt itself**, producing endless interruption
   loops — reported repeatedly. Echo cancellation is mandatory. Speaker output on a laptop
   without AEC will reliably trigger this.
6. **Function-call arguments occasionally leak into spoken output**, and the model
   sometimes hallucinates a tool result it never received. Validate tool output before
   trusting it, and don't assume audio matches the transcript.
7. **No determinism.** GA **removed the `temperature` parameter** — OpenAI's position is
   that low temperature does not make audio deterministic and high temperature produces
   audible artifacts. Control tone through prompting only. There is no way to guarantee an
   NPC says the same line twice, which breaks quest-critical dialogue, subtitle
   pre-translation, and QA reproducibility.
8. **Voice is locked once audio starts.** Choose per-session — so per-NPC voices mean
   per-NPC sessions, which multiplies both cost and concurrency. `marin` and `cedar` are
   the recommended-quality voices; the full set is `alloy`, `ash`, `ballad`, `coral`,
   `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`.
9. **October 2023 knowledge cutoff** — the model knows nothing about your game world.
   Everything comes from instructions and tools, against a 16,384-token instructions+tools
   budget.
10. **Moderation is your problem.** Players will say anything. Out-of-band responses
    (`response.conversation: "none"`) are the mechanism for screening without polluting
    conversation state.

**Operational**

11. **Content-rating and privacy exposure.** Sending player microphone audio to a third
    party has consent, age-rating, and regional (GDPR/COPPA) consequences that are a
    legal question, not an engineering one. Worth resolving early.
12. **Ephemeral tokens still need rate limiting** on your minting endpoint, or the token
    service becomes the abuse vector instead of the API key.

---

## 12. Open questions

- Actual measured latency on riki's own audio path — the public numbers are too scattered
  to plan against.
- Undocumented concurrent-session limits at our expected tier.
- Whether `gpt-realtime-2.1-mini` holds character/persona instructions well enough for
  NPC use; the "weaker instruction-following" caveat is exactly the axis that matters here.
- Whether a hybrid (cheap local STT → text LLM → cached/local TTS) beats speech-to-speech
  on cost for scripted-ish NPC dialogue, trading prosody for determinism and price.

---

## Sources

- [Realtime API overview](https://developers.openai.com/api/docs/guides/realtime) · [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) · [WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) · [WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket) — OpenAI
- [gpt-realtime model page](https://developers.openai.com/api/docs/models/gpt-realtime) — limits, tier rate limits, pricing
- [Developer notes on the Realtime API](https://developers.openai.com/blog/realtime-api) — session limits, truncation, `retention_ratio`, temperature removal
- [Managing costs](https://developers.openai.com/api/docs/guides/realtime-costs) — token accrual rates, caching
- [Context Summarization with Realtime API](https://developers.openai.com/cookbook/examples/context_summarization_with_realtime_api) — cookbook
- [Introducing gpt-realtime](https://openai.com/index/introducing-gpt-realtime/) — GA announcement
- [Agents SDK: JS](https://github.com/openai/openai-agents-js) · [Python realtime quickstart](https://openai.github.io/openai-agents-python/realtime/quickstart/) · [openai-realtime-agents](https://github.com/openai/openai-realtime-agents)
- [openai-agents-js #495](https://github.com/openai/openai-agents-js/issues/495) — GA/legacy config fallback bug
- [Measuring the response latency of OpenAI's WebRTC Realtime API](https://webrtchacks.com/measuring-the-response-latency-of-openais-webrtc-based-real-time-api/) — webrtcHacks, Jan 2025
- [Azure: GPT Realtime via WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc) · [via WebSockets](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets)
- [GPT-Realtime-2.1 / 2.1-mini release coverage](https://www.marktechpost.com/2026/07/06/openai-gpt-realtime-2-1-mini-reasoning-realtime-api/) — MarkTechPost
- Third-party cost/latency measurements (**unverified, directionally useful**): [HackerNoon, 4,000 sessions](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions) · [Fora Soft](https://www.forasoft.com/blog/article/openai-realtime-api-pricing) · [Layer3Labs](https://www.layer3labs.io/guides/openai-realtime-api-pricing)
- OpenAI Developer Community bug reports — self-interruption loops, function-call audio leakage, hallucinated tool results

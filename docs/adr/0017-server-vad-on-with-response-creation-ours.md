# ADR-0017: Server VAD stays on, with response creation ours

**Status:** Accepted
**Date:** 2026-08-01

## Context

`openai-realtime-research.md` §4 gives three turn-detection settings and describes
`turn_detection: null` as what push-to-talk *is*. [ADR-0004](0004-push-to-talk-default.md) makes
push-to-talk the default, so the null setting looks like the obvious consequence.

It interacts badly with [ADR-0002](0002-webrtc-transport.md). The same research section says
barge-in on WebRTC is "handled server-side, nothing to do", and presents the four-step manual
`conversation.item.truncate` dance as the WebSocket problem. That server-side truncation is driven
by the server detecting the user speaking — which is voice activity detection. Turning turn
detection off plausibly takes it with it, leaving us hand-rolling the exact thing the transport was
chosen to avoid.

## Decision

`turn_detection` stays enabled as `server_vad`, with `create_response: false` and
`interrupt_response: true`. The gesture remains the sole authority over when a response is
generated: `TurnController` sends `response.create` on trigger release, and nothing else does.
`silence_duration_ms` is set low (200 ms).

## Consequences

- Server-side truncation on barge-in keeps working, which is the single most important interaction
  in the product (ui-design.md §3.1) and the one whose failure corrupts every later turn.
- We get `input_audio_buffer.speech_started` / `speech_stopped` for free. `speech_started` arriving
  while our gate is closed is a usable signal that the model is hearing itself — the failure loop
  in research §11.5 — which under `turn_detection: null` we would have no way to notice.
- **A commit race appears.** With VAD on, the input buffer is committed when the server sees speech
  stop, so `response.create` sent the instant the key is released can outrun the tail of the
  utterance. The turn controller waits for `speech_stopped`, bounded by a 400 ms grace. That is up
  to 400 ms of pure latency on every turn, and it is the cost of this decision.
- Nothing is generated without our `response.create`, so ADR-0004's guarantee — no false triggers
  from teammates or game audio — is unchanged. The mic gate (ADR-0016) means VAD only ever sees
  audio the player deliberately sent.

## Alternatives rejected

- **`turn_detection: null`.** The textbook push-to-talk setting. Rejected because it likely gives
  up server-side barge-in truncation, which is most of the reason ADR-0002 chose WebRTC. If open
  question 3 in the design doc resolves the other way — that truncation survives with detection off
  — this becomes a preference rather than a necessity, and the 400 ms grace can go.
- **`semantic_vad`.** Better for hesitant speakers, and irrelevant when a held key already says
  where the utterance ends. It costs latency on a path that has none to spare.
- **VAD on with `create_response: true`.** Riki would answer whenever the player stopped talking,
  including mid-thought, and would answer teammates the moment the gate was open. This is the
  behaviour ADR-0004 exists to prevent.

See [voice-input-architecture.md](../design/voice-input-architecture.md) §5.4, §5.5 and
[openai-realtime-research.md](../research/openai-realtime-research.md) §4.

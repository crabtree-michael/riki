# ADR-0016: The microphone is opened per match; the gate is in our audio graph

**Status:** Accepted
**Date:** 2026-08-01

## Context

[ADR-0004](0004-push-to-talk-default.md) says the mic is closed except while the trigger is held,
and gives "the privacy story is trivial to explain" as a reason. The obvious implementation is
`getUserMedia` on key-down and stopping the tracks on key-up.

Two things make that unworkable. Opening a capture device costs roughly 50–300 ms depending on
platform and whether the device is shared, which spends the whole ≤100 ms key-down→chip-visible
budget and the ≤250 ms bars-respond budget from ui-design.md §8 on something the player reads as
the app being broken. And ui-design.md §3 gives the Armed state a pre-roll buffer so the first
syllable is not clipped — there is nothing to buffer if the device is not already running.

## Decision

The capture device is opened when a match starts and released when it ends. Push-to-talk gates a
`GainNode` inside our own Web Audio graph, upstream of the track handed to WebRTC, so a closed gate
means nothing reaches the encoder — not merely that a flag is set. Pre-roll is a `DelayNode` in
front of the gate: opening the gate emits audio captured `preRollMs` earlier, at the cost of every
utterance being that much later.

## Consequences

- The OS microphone indicator shows Riki as using the mic for the whole match rather than blinking
  per utterance. This is the real cost of the decision. It is disclosed in onboarding and mirrored
  by Riki's own indicator, and it is arguably the more truthful state: the app *can* hear, and what
  stops it is our code rather than the operating system.
- ADR-0004's one-sentence privacy story needs a second sentence. "The mic is closed except while
  you hold the key" becomes "nothing is transmitted except while you hold the key, and the device
  stays open so the first word is not clipped." Worse copy, accurate copy.
- The gate is now a testable claim: with it closed, the outbound track carries no signal, and that
  is an assertion rather than a policy.
- Pre-roll is pure added latency — 200 ms by default against a ~1–1.5 s conversational turnaround.
  It is a setting and it is allowed to be zero.
- Device loss mid-match becomes ordinary: the source node is swapped without touching the gate, the
  track identity, or the peer connection, so no SDP renegotiation and no interrupted turn.

## Alternatives rejected

- **`getUserMedia` per press.** Misses two timing budgets, blinks the OS indicator, and makes
  pre-roll impossible. The privacy gain is real but is a gain over a state nothing is transmitted
  from anyway.
- **`track.enabled = false` between presses.** One line instead of a graph, but it gives up
  pre-roll entirely and puts the gate downstream of the point where we can prove anything about it.
- **Buffer pre-roll and flush it on key-down.** There is no way to inject a buffer into an RTP
  stream after the fact; catching up would require rate conversion, which pitch-shifts exactly the
  words the pre-roll existed to save.

See [voice-input-architecture.md](../design/voice-input-architecture.md) §3.1–§3.3 and
[ui-design.md](../design/ui-design.md) §3, §8.

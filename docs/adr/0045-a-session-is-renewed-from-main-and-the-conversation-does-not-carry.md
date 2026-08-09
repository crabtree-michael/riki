# ADR-0045: A session is renewed from main, and the conversation does not carry across

**Status:** Accepted
**Date:** 2026-08-09

**Discharges:** the renewal path [ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md)
records as owed — *"a renewal path that reopens transparently and does not lose the conversation."*

## Context

Observed live on 2026-08-09 at 15:43:36:

```text
session_expired — "Your session hit the maximum duration of 60 minutes."
```

The data channel closed, ICE disconnected, and nothing reconnected. Riki was mute for the rest of a
match it was still nominally in, and nothing anywhere said why — the chip showed no fault, because
the only path to one was an `error` event on a transport that had just stopped carrying events.

Three separate things were missing, and each of them alone is enough to produce that outcome:

1. **The expiry was classified as `offline`.** `faultFor` in `packages/realtime/src/session.ts`
   matched `session_lost` and `connection` and nothing else, so `session_expired` fell through to
   the default. Retryable, so not fatal — but named after a network problem, which is where anyone
   reading the log would have looked.
2. **A dead peer connection was silent.** `PeerConnectionLike.onConnectionStateChange` existed, and
   `renderer/voice/peer.ts` implemented it, and *nothing subscribed to either*. The WebRTC
   transport could reach `closed` only from its own `close()` and from a refused SDP POST. So a
   transport whose peer connection had died reported `open` indefinitely and every layer above kept
   sending client events into a channel that was gone.
3. **Nothing renewed.** `SessionSupervisor` was declared in `session.ts` with `rotate(reason)` and a
   `rotateAfterMs` of 50 minutes, and had no implementation. A one-session-per-match design was
   survivable while Riki mostly sat quiet; ADR-0042 makes Riki an assistant that is expected to
   answer at minute 61 of a long game, and Dota matches plus draft plus post-game routinely pass an
   hour.

The obvious home for renewal is `packages/realtime`, beside the declaration. It does not work, for
one reason: a new session needs a new client secret, minting needs the `ApiKey`, and
[ADR-0015](0015-ephemeral-client-secret-minted-in-main.md) puts the key in main and the peer
connection in a renderer. The voice window's `CredentialPort.acquire()` resolves the constant it was
handed in the `voice.session.open` directive; it has nothing to mint with and must not.

## Decision

**Detection lives in `packages/realtime`, where the transport is. Renewal lives in main, where the
key is. What carries across the boundary is the instructions, and nothing else.**

### Detection — `packages/realtime`

- `faultFor` matches the expiry *before* it matches auth, and classifies it as `session-lost`,
  `persistent: false`, `retryable: true`. As `auth` it would be persistent and non-retryable, which
  is exactly the shape that stops a supervisor renewing.
- `createRealtimeSession` subscribes to `transport.onStateChange` and raises the same fault when the
  transport closes without being asked to. `close()` sets a flag first, so an orderly teardown — a
  match ending, a renewal replacing the session — is not reported as a loss.
- The WebRTC transport subscribes to `onConnectionStateChange` and maps `failed` and `closed` to
  `closed`. **Not `disconnected`:** ICE reports that after a few missed consent checks and returns
  to `connected` when the network settles, and renewing a working session on a Wi-Fi blip costs the
  conversation for nothing. If it does not recover, ICE gives up on its own and arrives as `failed`.
- **One loss, one fault.** The expiry arrives as an error *and* as a dead transport, in either
  order; whichever reaches the session first reports it and the other stays quiet.

### Renewal — `apps/desktop/src/main/voice/session.ts`

Main mints and sends `voice.session.open` again. That is the whole mechanism: the voice window's
handler already closes the live session before opening a new one, so rotation is a directive rather
than a new message. `schemas/voice.ts` is unchanged and this is not a protocol coordination event.

- **Before the cap, not after it.** A timer at 50 minutes (`DEFAULT_RENEW_AFTER_MS`, derived as
  `SESSION_MAX_DURATION_MS - SESSION_RENEW_MARGIN_MS`) renews while the old session still works. The
  ten-minute margin is not clock-skew caution — it is the width of the window in which a renewal may
  fail and be retried. The reactive path is the backstop, not the plan.
- **Armed from `ready`, not from the send.** `ready` is the closest signal we have to the moment the
  API started counting; the mint, the SDP exchange and the DTLS handshake all sit between the
  directive and that.
- **`ready` is also the only evidence a renewal landed**, and the only thing that resets the attempt
  budget. A directive sent into a wedged voice window produces no error of any kind, so a renewal
  with no deadline on it is indistinguishable from the expiry it was meant to repair.
- **The player is not told.** A fault that starts a renewal is swallowed rather than emitted, and a
  second signal of the same loss finds a renewal already running. The player hears about it exactly
  once, and only after renewal has run out of attempts.
- **The inspector is told, in the trace and not in Problems.** `VoiceSessionTelemetry.renewal` has
  four phases — `started`, `opened`, `retrying`, `gaveUp` — and only `gaveUp` is also a problem. A
  renewal is progress; the point of a separate signal is that it must be *visible* without being
  *alarming*, and the failure it replaces was invisible.

### What carries across the boundary

**The instructions, byte-identically.** They are the cached prefix, and a prefix that differs by a
character is a cold cache at full price. Nothing derived from current match state may be folded in.

**The conversation does not.** The API's conversation dies with the session, and ADR-0042 deleted
the ledger that [ADR-0012](0012-conversation-ledger-is-ours.md) built to rehydrate from. The
reopened session starts cold.

This is survivable *because* of ADR-0042, and would not have been before it. Riki no longer decides
when to speak; it answers a question from a snapshot rendered fresh at the moment of the turn. A
cold session answers the next question exactly as well as a warm one, and the repetition risk
ADR-0012 was written about — *don't repeat advice the player already acted on* — belongs to a coach
that starts turns, which this one does not.

## Consequences

**Two things are genuinely lost at the boundary, and neither is hidden.** A follow-up asked across
it ("what about him?") has nothing to resolve against, and a turn in flight ends in silence. Both
are one-turn costs, roughly once an hour, against a session that currently dies for good.

**The reconnect path is exercised on every long match** rather than only when the network fails,
which was the original argument for building rotation at all. A renewal and a recovery are the same
code with a different trigger.

**`SessionSupervisor` in `packages/realtime` stays declared and unimplemented, and now says so.** It
is reachable only by giving the renderer a way to *request* a credential from main, which is a
change to `schemas/voice.ts` and therefore a coordination event. If that message is ever added for
another reason, moving renewal down is a small change; until then the declaration would otherwise
read as a contract that exists.

## Alternatives considered

**Carry a tail of the conversation into the new session.** Main sees every final transcript and
could append the last few exchanges to the renewed instructions; prompt caching matches on prefix,
so appending would not cost the cache. Not chosen: it makes main *retain* player transcript text,
which nothing in the app does today — the inspector deliberately records the player's side as a
length only — and it buys the follow-up-pronoun case roughly once an hour. It is the obvious
refinement if the boundary turns out to be noticeable in practice, and it should be a decision about
privacy defaults rather than a detail of a renewal patch.

**Renew reactively only, with no timer.** Simpler, and it is what the code does when no `Timers` is
injected. Rejected as the product path because it guarantees a window — however short — in which the
player presses the key and Riki cannot answer. It survives as the degraded mode rather than as the
design.

**Put renewal in `packages/realtime` behind a credential request over the bridge.** The
architecturally tidy answer, and where `SessionSupervisor` was declared. Rejected for now on cost:
it is a protocol coordination event and a new request/response shape across the preload bridge, to
move code that works into a package that cannot mint. Reconsider if the renderer ever needs to ask
main for anything else.

**Treat `disconnected` as a lost transport.** It would catch the observed ICE failure a few tens of
seconds earlier. Rejected: it also renews on every transient network blip, and a renewal is not
free — it is a cold conversation.

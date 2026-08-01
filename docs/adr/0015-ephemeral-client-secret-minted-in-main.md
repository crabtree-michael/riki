# ADR-0015: The ephemeral client secret is minted in the main process

**Status:** Accepted
**Date:** 2026-08-01

## Context

Three prior decisions meet in the voice path and, read together, look contradictory.
[ADR-0002](0002-webrtc-transport.md) puts the WebRTC peer connection in a Chromium renderer, so
the renderer is what authenticates to OpenAI. [ADR-0006](0006-env-var-api-key-for-alpha-beta.md)
supplies the credential as `RIKI_OPENAI_API_KEY` in a developer's `.env`. REPO_SKELETON.md §7.1
says that key is read in exactly one module, in the **main** process, never crosses the preload
bridge, and is redacted everywhere. A renderer that must authenticate and must never hold the
thing it authenticates with.

## Decision

Electron main is Riki's token-minting service. `ClientSecretBroker` in `packages/realtime`, running
in main and holding the injected key, calls `POST /v1/realtime/client_secrets` and passes only the
resulting short-lived secret across the preload bridge. The renderer authenticates the SDP exchange
with that secret and never sees the key. `OpenAI-Safety-Identifier` is set by the broker from a
hashed install id, never by the renderer.

## Consequences

- REPO_SKELETON §5.4's test "the key is absent from the preload bridge surface" becomes a statement
  about a surface that structurally cannot carry it, rather than a rule someone has to keep.
- Secrets expire, so "my credential is stale" is an ordinary event on the renderer side — handled
  on reconnect and on session rotation, not as a fatal error. That is extra state we would not
  otherwise have.
- We inherit the abuse-vector warning from `openai-realtime-research.md` §12 in miniature: the mint
  path is local and unauthenticated by construction, which is acceptable only while the key is the
  developer's own (ADR-0006) and stops being acceptable at distribution.
- When REPO_SKELETON §11.2 is settled and a real minting service exists, it replaces this class's
  implementation and nothing else changes. The seam is the point.

## Alternatives rejected

- **Pass the API key to the renderer.** Simplest, and it deletes the single clearest security
  property the repo has. A key in a renderer is a key in a crash report and a key in a DevTools
  session.
- **Move the peer connection to main and keep the key there.** Node has no `getUserMedia` and no
  echo canceller; ADR-0002 chose WebRTC precisely for Chromium's AEC, so this gives up the reason
  the transport was chosen.
- **Use the WebSocket transport from main with the key.** Viable, and it is why
  `RIKI_REALTIME_TRANSPORT` exists — but it means owning jitter buffering, echo cancellation and
  manual barge-in truncation, which ADR-0002 already declined.

See [voice-input-architecture.md](../design/voice-input-architecture.md) §5.1 and
[openai-realtime-research.md](../research/openai-realtime-research.md) §2, §6.

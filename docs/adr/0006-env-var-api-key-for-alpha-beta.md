# ADR-0006: An environment-variable API key for alpha and beta

**Status:** Accepted for alpha and beta. **Expected to be superseded** before the first build
goes to anyone outside the team.
**Date:** 2026-08-01

## Context

Riki needs an OpenAI API key to open a Realtime session. A key cannot ship inside a distributed
binary — the realtime research is right about that. But nothing is being distributed yet: the
only users are the people building Riki, who need direct key access anyway.

## Decision

During alpha and beta each developer supplies their own key via `RIKI_OPENAI_API_KEY` in a local
`.env`. No minting service, no backend, no accounts.

The key is read in exactly one place — `packages/config`, in the Electron main process — and
injected into `packages/realtime`. It does not cross the preload bridge, so the renderer never
sees it, and `packages/telemetry` redacts it alongside chat text and Steam IDs.

The key is **conditionally required**: absent, the app boots with voice disabled and says so.
That is the mode fixtures, tests, and CI run in.

## Consequences

- Setup is two lines: `cp .env.example .env`, then fill in one variable.
- `pnpm check` passes on a machine with no key at all, and `pnpm dev:replay` drives the whole app
  from fixtures without one. No test costs money.
- `.env` being gitignored is load-bearing, so a test asserts the entry exists and gitleaks backs
  it up.
- This stops being adequate the moment Riki reaches someone who is not building it. Confining
  the key to `packages/config` is what keeps that swap a one-file change.

## Alternatives rejected

- **A token-minting service now** — hosting, accounts, and rate limiting (the mint endpoint
  becomes the abuse vector) to solve a distribution problem that does not exist yet.
- **The key in the committed user config file, or read directly by `packages/realtime`** — both
  put a live key somewhere a lint rule cannot see it.

The open question of what replaces this — user-supplied key in settings, a minting service, or
bring-your-own-key with a hosted option later — is
[REPO_SKELETON.md](../../REPO_SKELETON.md) §11.2. Record the answer as a new ADR that supersedes
this one rather than editing this file.

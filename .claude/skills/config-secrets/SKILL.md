---
name: config-secrets
description: Configuration, the OpenAI API key, and privacy defaults — `packages/config`, `.env`, `.env.example` and `packages/telemetry` redaction. Covers layered resolution, why `process.env` is readable in exactly one module, how the key reaches `packages/realtime` without touching the renderer, and which defaults must stay off. Use when adding a setting, an environment variable, or anything that logs.
---

# Config, secrets and privacy defaults

## One module reads the environment

`packages/config` is the **only** place `process.env` may be read, and a lint boundary
enforces it. Everything else takes injected config. That is what makes config testable, and
it means there is exactly one file to audit for secrets and exactly one file to change when
the key stops coming from `.env`.

Resolution is layered, highest wins: CLI flags → environment → user config file → committed
defaults. Validated with zod once at startup.

**Invalid config fails at startup, loudly, naming the offending key.** Riki must never
half-boot with a broken setting and no error — discovering it ten minutes into a game is the
failure this rule exists to prevent.

## The API key (alpha and beta)

`RIKI_OPENAI_API_KEY`, from the developer's own `.env`. No minting service, no backend.

- Read by `packages/config` **in the Electron main process** and injected into
  `packages/realtime`. It does not cross the preload bridge, so the renderer never sees it.
- **Redacted by `packages/telemetry`** alongside chat text and Steam IDs. A key in a crash
  report is a leaked key.
- **Conditionally required.** Absent, the app boots with voice disabled and says so in the
  UI — that is the mode fixtures, tests and CI all run in. Present but malformed, or absent
  when something asks for a live session, fails loudly.
- `.env` is gitignored; `.env.example` is committed with every variable documented and no
  real values. gitleaks is the backstop, but the `.gitignore` line is the actual protection
  and a test asserts it is there.
- A build-artifact scan looks for key-shaped strings. The key is only ever read from the
  environment at runtime, so a key in a bundle means someone hardcoded one.

This arrangement is deliberately temporary and stops being adequate the moment Riki reaches
someone who is not building it. Keeping the key confined to `packages/config` is what makes
that swap a one-file change — do not spread it.

## Privacy defaults are off, and tested

Captions off. Unprompted speech off. Chat egress off. Debug frame capture off. No capture
path for game audio output at all. **Assert the defaults in tests** — a privacy default that
is only written down is a privacy default that will drift.

Adding a new setting means adding it to `.env.example` with a comment in the same commit,
and stating its default's rationale if it touches privacy.

## Logging

**No `console.*` outside `packages/telemetry`.** Logs pass through redaction — chat text,
Steam IDs, the API key — before they reach a sink. A bypass is a leak.

## Learnings

*(nothing yet — the first agent to learn something here adds the first entry)*

## See also

`REPO_SKELETON.md` §7 (config and the key), §5.4 (the leak tests), §6.2 (boundaries),
§11 item 2 (what replaces the env-var scheme at distribution — open);
`docs/dota2-state-capture-design.md` §7 (privacy).

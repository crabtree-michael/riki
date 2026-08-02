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

**2026-08-02 — a *fake* API key in a test fails the pre-commit gate, and so does writing about
one.** gitleaks' `generic-api-key` rule is entropy-based, not prefix-based, so an `sk-` prefix
followed by a realistic-looking random tail in `packages/config/src/load.test.ts` was reported as a
leak and blocked the commit. The fix is a **low-entropy** fake — a repeated-syllable tail rather
than a random one — not an allowlist entry: an exception carved for a test is an exception that
will one day cover a real key.

Two things that cost a second and third attempt. The scan reports one finding at a time, so rescan
(`node scripts/gitleaks.mjs --staged`) rather than assuming one edit cleared it. And **this entry
originally quoted the offending literal**, which meant the skill file itself then failed the scan —
prose about a secret is scanned exactly like code. Describe the shape; do not paste it.

**2026-08-02 — the layered resolver landed, and two of `.env.example`'s documented values were
wrong.** `RIKI_VISION=on` contradicted the shell's own default of `false` (ADR-0030: no platform
backend can capture, so `on` costs ten supervisor restarts per launch), and the shell's
`DEFAULTS.unprompted = true` contradicted §7.2 rule 2, which requires unprompted speech **off**.
Both are fixed and the privacy four are now asserted one test each in `packages/config`. *Why:* a
default written in three places — the design doc, `.env.example`, and a stand-in in the app — will
disagree in at least one of them. There is now one authority (`schema.ts`'s `DEFAULTS`) and
everything else is a projection of it; keep it that way.

**2026-08-02 — the API key deliberately has no CLI flag and no `settings.json` row.** Every other
setting is a row in `keys.ts` and gets both for free, mechanically. The key is not a row: a flag
would put a live key in the machine's process list, and `settings.json` is neither gitignored nor
redacted. It is read in `env.ts` from the environment only, and handed to the `ApiKey` constructor
in the expression that reads it (ADR-0022 is explicit that wrapping a value that was already copied
into a variable is closing the door afterwards). *Why:* the obvious next feature request is "let me
set the key in settings" — the answer is a keychain, not a row in that table.

**2026-08-02 — a blank environment variable has to mean *unset*, or a copied `.env.example` breaks
the app.** The example ships `RIKI_GSI_TOKEN=`, `RIKI_DOTA_PATH=` and four others with no value,
because that is how it documents them. Treated as values, copying the file unchanged blanks the
per-install GSI token and every POST from Dota is refused with a 403 that looks exactly like a
misconfigured cfg. `fromEnv` skips blanks and `optionalText` maps a blank to `null`, and there is a
test for each. The same rule applies to the real environment overlaying `.env`.

**2026-08-02 — an unknown key in `settings.json` is fatal, and that is the point.** A typo there
otherwise means the setting silently does nothing, which is the ten-minutes-into-a-game discovery
§7 exists to prevent. Nothing writes that file, so there was no migration to weigh against saying
so. If something ever does write it, this decision needs revisiting rather than working around.

## See also

`REPO_SKELETON.md` §7 (config and the key), §5.4 (the leak tests), §6.2 (boundaries),
§11 item 2 (what replaces the env-var scheme at distribution — open);
`docs/dota2-state-capture-design.md` §7 (privacy).

# Runbook: development setup

## Prerequisites

- **Node 22+** and **pnpm 11+**
- **Rust 1.82+** via [rustup](https://rustup.rs) — needed for `crates/`. Without it the cargo
  steps in `pnpm check` skip with a notice rather than failing, so TypeScript-only work does not
  need a toolchain.
- **git-lfs** — for the frame fixtures. Without it, tests that need frames skip with a message.
- Optional but wanted: [gitleaks](https://github.com/gitleaks/gitleaks) for the pre-push secret
  scan. Without it the hook skips with a notice, and since CI is not active yet (below) nothing
  else is scanning — so on a machine without it, nothing checks a push for secrets at all.

## Fresh clone

```shell
pnpm setup
```

That installs dependencies, fetches LFS fixtures, generates protocol types, installs git hooks,
and creates `.env` from `.env.example`.

One line still needs you, and only for live voice:

```shell
RIKI_OPENAI_API_KEY=sk-...
```

Leave it blank to run fixtures-only. `pnpm test`, `pnpm check`, and `pnpm dev:replay` all work
with no key at all — see [ADR-0006](../adr/0006-env-var-api-key-for-alpha-beta.md).

## Day to day

| Command           | Does                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `pnpm check`      | lint + format + typecheck + test + codegen-clean. **The only gate — CI is not active yet. Run it before committing.** |
| `pnpm test`       | Vitest + `cargo test`. No game, no network, no GPU, no API key.                               |
| `pnpm dev:replay` | The whole app driven from fixtures. No Dota and no API key required.                          |
| `pnpm dev`        | Electron + Vite HMR + `cargo watch`. Needs a key for live voice.                              |

The full list is [REPO_SKELETON.md](../../REPO_SKELETON.md) §8.1. If a command you need is not
there, it should be — add it under a canonical name rather than inventing a second one.

## What is not scaffolded yet

`pnpm dev`, `pnpm dev:replay`, `pnpm test:e2e`, and `pnpm build` print what they are blocked on
and exit non-zero. The scaffolding order in [REPO_SKELETON.md](../../REPO_SKELETON.md) §10 says
which step unblocks each.

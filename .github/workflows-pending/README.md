# Pending workflows — one `git mv` from being live

These three files are the CI described in [REPO_SKELETON.md](../../REPO_SKELETON.md) §8.2. They
are finished and they belong in `.github/workflows/`. **They are not running yet**, because
GitHub refuses a push that creates or updates anything under `.github/workflows/` unless the
token carries the `workflow` scope, and the token available when the skeleton landed had only
`repo`.

Parking them here rather than deleting them keeps the work reviewable and makes activating it a
single command for anyone whose credentials allow it:

```shell
git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml
git mv .github/workflows-pending/bench.yml .github/workflows/bench.yml
git mv .github/workflows-pending/docs.yml .github/workflows/docs.yml
git rm .github/workflows-pending/README.md
```

Nothing inside the files needs changing — their `paths:` filters already refer to the
`.github/workflows/` locations.

## What they do

| File | Jobs |
|---|---|
| `ci.yml` | lint · typecheck · test on ubuntu + windows; cargo fmt/clippy/test; codegen-clean; gitleaks; cargo-deny |
| `bench.yml` | criterion micro-benchmarks over `crates/`, on changes under `crates/` or `bench/cv/` |
| `docs.yml` | markdownlint (error) + lychee link check (warn) |

`ci.yml` runs with `RIKI_OPENAI_API_KEY` unset, which is the mode agents work in and the mode
§7.1 requires: no test may need a live OpenAI session.

## Until then

`pnpm check` is the same gate, and it runs locally. It is green as of the scaffolding commit.
The gap is that nothing enforces it on push, and that the Rust jobs — which are the first real
compile of `crates/` — have not run anywhere yet.

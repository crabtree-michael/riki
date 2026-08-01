# ADR-0008: Pre-commit is the gate; there is no CI

**Status:** Accepted
**Date:** 2026-08-01

## Context

`REPO_SKELETON.md` §8.2 assumed GitHub Actions would enforce the gate. It never did. The three
workflows were written during scaffolding but could not be pushed — GitHub rejects any push
touching `.github/workflows/` unless the token carries the `workflow` scope, and every token
available so far has had only `repo`. They sat in `.github/workflows-pending/` for weeks while
the docs in five files told agents that `pnpm check` was "what CI runs".

Measured, not assumed: with hooks as they were, a deliberate type error and a failing test were
committed and pushed to a scratch remote without complaint. Only `gitleaks` and the LFS transfer
ran on push. Nothing checked the code.

The deeper problem is that CI is the wrong shape for this repository. Riki is built by agents
(`AGENTS.md`): an agent commits, reports "done", and its context ends. A failure surfaced minutes
later in a cloud log has no reader — the agent that caused it is gone, and the next one starts
from `git log`. Feedback has to arrive while the author still exists.

## Decision

The full gate runs on **pre-commit**, in `lefthook.yml`. Everything the CI workflows did is
ported there except the two things that cannot sensibly run per-commit: the Playwright e2e suite
and the criterion benchmarks. The `.github/workflows-pending/` directory is deleted rather than
left as a decoy.

Because pre-commit is now the only enforcement, bypassing it is not a shortcut but a hole in the
entire safety net. `scripts/block-no-verify.mjs` is wired as a Claude Code `PreToolUse` hook in
`.claude/settings.json` and refuses `git commit --no-verify`, `git commit -n`,
`git push --no-verify`, `core.hooksPath` overrides, and `LEFTHOOK=0`.

Rust steps (`clippy`, `cargo test`, `cargo-deny`, `rustfmt --check`) are scoped by glob to
commits that touch `crates/`, `Cargo.toml`, `Cargo.lock` or the Rust config files. Everything
else runs on every commit. Measured cost: **~8s** for a TypeScript commit, **~8s** for a Rust one
with a warm cargo cache.

## Consequences

**The Windows matrix is gone, and that is the real cost.** §8.2 called it load-bearing: Linux is
the dev platform, Windows is the shipping target, and `dota2-state-capture-design.md` §2.1 flags
Linux/Proton GSI as historically buggy. Divergence will now surface in a bug report rather than a
red build. Nothing in this repo currently compiles per-platform, so the loss is theoretical
today, but it becomes real the moment `crates/riki-capture` grows a WGC backend. **A future CI
should be reinstated for the platform matrix specifically** — not to re-run what pre-commit
already covers.

Also lost: the e2e and bench jobs have no home. They were never wired (the code does not exist —
§10 step 6), so nothing regresses, but they now need a deliberate decision rather than an
inherited workflow file.

The guard is only as good as the surface it covers. It intercepts Claude Code's Bash tool, so it
constrains **agents**, which is who this is for. A human in a terminal is unaffected, and an
agent that shells out through a wrapper the matcher does not see is unaffected. Client-side hooks
cannot be made mandatory; only a server-side check could, and GitHub offers none below
Enterprise.

Two smaller ones. A fresh clone that has not run `pnpm install` has no hooks at all, so the gate
is absent exactly when someone is least likely to notice. And the whole-repo steps check the
working tree, not the staged content — unrelated unstaged edits are included in the verdict,
which is documented at the top of `lefthook.yml`.

## Alternatives rejected

**Activate the workflows and keep CI as the gate.** Blocked on a token scope nobody has, and it
would have preserved the fundamental mismatch: the feedback still arrives after the agent that
needs it has stopped existing.

**Pre-push instead of pre-commit.** Batches failures to the end of a work session, so an agent
learns its third commit was broken while trying to ship its tenth. Pre-commit fails the one
change that caused it, which is the only point where the fix is obvious.

**Keep the workflows parked as documentation.** Rejected because a file that looks like
enforcement and is not is worse than no file — that misreading is precisely what produced the
five stale docs this ADR replaces.

**A `pnpm check` step in pre-push as well.** Redundant once pre-commit is green, and it doubles
the cost of the operation agents perform most.

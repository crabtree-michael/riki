# Contributing to Riki

This file is for humans. Agents working here should read [AGENTS.md](AGENTS.md) first, then
[REPO_SKELETON.md](REPO_SKELETON.md) §9.

## Setup

```shell
pnpm setup
```

Prerequisites, what each step does, and what to do without a Rust toolchain are in
[docs/runbooks/dev-setup.md](docs/runbooks/dev-setup.md).

You do **not** need Dota 2, a microphone, a GPU, or an OpenAI API key to work on most of this
repo. That is deliberate, not a coincidence — see the rule below.

## Where does my change go?

[REPO_SKELETON.md §2.2](REPO_SKELETON.md) has the full ownership map. The short version:

- Business logic — the world model, snapshot rendering, salience scoring — lives in
  `packages/`, where it is testable in milliseconds with no window and no game.
- `apps/desktop` is wiring, windows, and platform calls. Keep it thin.
- `crates/` is the capture and CV sidecar, which runs as a separate process so it can crash
  without taking the agent down.
- Anything crossing a process or language boundary goes through `packages/protocol` **first**.
  Changing it changes two languages, so say so in your commit message — someone else may be
  mid-task against the old shape.

## The rule that shapes everything

> No test may require a running Dota 2 client, a real microphone, a GPU, or a live OpenAI
> session. Every external input has a fixture and a fake.

Add the fixture alongside the code. A parser without a fixture is untestable by whoever comes
next. The fakes in each package's `testing/` subpath are shared with `pnpm dev:replay`, which is
what keeps them honest.

## Before you commit

```shell
pnpm check
```

That is lint, format, typecheck, test, and codegen-clean.

**You do not have to remember it.** `lefthook` runs the same gate on `git commit` and refuses the
commit if anything fails ([ADR-0008](docs/adr/0008-pre-commit-is-the-gate.md)) — about 8 seconds.
Running `pnpm check` by hand just lets you see the verdict sooner.

**There is no CI**, so that hook is the only thing checking anything. Skipping it is blocked
rather than discouraged: `--no-verify`, `git commit -n`, `core.hooksPath` overrides and
`LEFTHOOK=0` are all refused for agents. If the gate is wrong, change `lefthook.yml` in a commit
that says why — do not go around it.

Also:

- New behaviour has a test at the lowest tier that can catch it
  ([REPO_SKELETON.md §5.3](REPO_SKELETON.md)).
- A design decision is an [ADR](docs/adr/), not a comment in the code.
- If you left something undone, the commit message says what and why.

## Commits and branches

`main` is the trunk and commits go to it directly — there is no review queue. Write the commit
message for someone whose only context is `git log`: what changed, and why.

If something you did is partly blocked, land what works and say plainly what you did not do. An
honest gap someone can route around is far more useful than a silent one.

---
name: workspace
description: How work is organised in the Riki repo — which package owns a change, what `pnpm check` must say before you commit, how to commit to `main` while other agents work in parallel, and how to update these skills when you learn something. Use at the start and end of any task in this repository.
---

# Working in the Riki repo

Riki is a voice coach for Dota 2 that is *invisible until needed*. That product promise is
the source of most of the constraints you will hit, in every area.

## Read these first, in this order

| Question | File |
|---|---|
| Who dispatched this task, what "done" means | `AGENTS.md` |
| Where my code goes, testing, linting, CI | `REPO_SKELETON.md` |
| Is this already decided? | `docs/adr/` |
| How the subsystem is meant to work | `docs/` |

## Which package owns my change

`REPO_SKELETON.md` §2.2 is the ownership map — task shape on the left, directory on the
right. Use it rather than guessing; the layout exists specifically so two agents working in
parallel touch disjoint directories.

Two rules follow from that:

- **Stay in your directory.** If the task seems to need a change in someone else's package,
  that usually means the seam is in the wrong place. Say so in your report instead of
  reaching across.
- **`packages/protocol` is the exception, and it is a coordination event.** See the
  `protocol` skill before touching it.

## Before you commit

- `pnpm check` is green. It is lint + format:check + typecheck + test + codegen:check. **The
  pre-commit hook runs the same gate and will refuse the commit if it fails** (~8s, ADR-0008),
  so running it yourself is just seeing the verdict early. There is no CI behind it, and
  `--no-verify` is blocked — if the gate is wrong, change `lefthook.yml` and say why.
- New behaviour has a test at the lowest tier that can catch it (`testing` skill).
- A decision you made is an ADR in `docs/adr/`, not a code comment.
- Something you learned is in the area's skill (below).

**Definition of done:** the work is on `main`, `pnpm check` is green, the behaviour is
covered by a test that runs without Dota 2 or a live API, and what you learned is written
down where the next agent will hit it.

## Committing alongside other agents

Agents commit directly to `main`; there is no review queue. Pull before you start and again
before you push. If someone landed while you worked, reconcile it yourself — leaving it for
the next agent is how a repo stalls.

Write the commit message for someone whose only context is `git log`. If you left part of
the task undone, say what and why in the message.

**Claim an ADR number from `ls docs/adr/`, immediately before you commit — not from the
table in `docs/README.md`, and not at the start of your task.** The table lags by a commit,
and the gap between reading it and pushing is long enough for another agent to take the
number. Re-check after your final `git pull --rebase`; renumbering afterwards means moving a
file and chasing its inbound links.

## Updating a skill

Every area has a skill in `.claude/skills/`. When you finish a task, ask: *did I learn
something that would have saved me time at the start?* If yes, it goes in that area's skill
**in the same commit as the work** — there is no follow-up task, and the next agent in this
area will be someone else.

**Qualifies:** a mistake the docs did not warn you about · a command or incantation that
worked after several that did not · a limit or quirk you measured rather than read · an
approach you tried and abandoned, with why.

**Does not:** restating a design doc · general TypeScript or Rust advice (the
`superpowers:*` skills cover method) · anything true only of the data in your one task.

**It may belong somewhere else.** Contradicts a design doc → fix the doc. Is a decision →
ADR. Is a fact about an external system → a research note in `docs/`. Is "how not to get
this wrong here" → the skill. That last one is the default.

Add it under `## Learnings` with the date and one line of *why*. If it changes how the area
should be worked, promote it into the body as a rule. Full rules: `REPO_SKELETON.md` §13.

## Learnings

**2026-08-01 — A lint rule you cannot see fail is decoration.** The `boundaries/*` rules in
`eslint.config.js` are how §6.2's design decisions actually hold, and three of the four
silently passed when first written. Two causes, both non-obvious:

- Boundary rules only fire on imports that **resolve**. Under NodeNext the codebase writes
  `./foo.js` for `./foo.ts`, which the default resolver cannot follow, so the rule sees
  nothing and reports success. `eslint-import-resolver-typescript` is configured under
  `settings['import/resolver']` for exactly this; do not remove it.
- A cross-package import written by name (`@riki/realtime`) is **external** to boundaries, not
  an element, so `boundaries/element-types` never sees it. Package-to-package rules have to be
  expressed in `boundaries/external` as well. `element-types` still covers relative imports
  within an element, which is why both blocks exist.

  **Correction, 2026-08-01:** that second bullet is only true while the import does not resolve.
  Once the importing package actually declares the dependency — which is the only situation the
  rule needs to catch — `eslint-import-resolver-typescript` resolves `@riki/realtime` to
  `packages/realtime/**`, boundaries matches it as a **`package` element**, and it is
  `element-types` that fires while the `external` rule stays silent. Verified by adding the
  dependency, linting, and removing it again. So: express package-to-package rules in
  **`element-types`** (as the `world-model → realtime` rule already did), and reserve
  `boundaries/external` for genuine node_modules packages such as `electron` and `openai`. A rule
  written only in `external` will pass on a real violation.

*Why:* if you add or edit a boundary rule, write a throwaway file that violates it, run
`pnpm exec eslint <file>`, confirm the error, then delete it. Ten seconds, and it is the
difference between a rule and a comment.

**2026-08-01 — `pnpm check` runs green without a Rust toolchain.** The cargo steps skip with a
`[cargo] skipped …` notice instead of failing (`scripts/cargo.mjs`), so TypeScript-only work is
not blocked on installing rustup. *Why:* a green check does **not** mean the Rust side built.
Read the output, and if you touched `crates/`, either install the toolchain or say plainly in
your commit message that CI is the first real check of it.

**2026-08-01 — and the first time a toolchain existed, both Rust gates failed.** The skeleton
was recorded as green, but that greenness was three `[cargo] skipped` notices. Installing rustup
turned up `clippy::pedantic` doc failures in all three crate headers and a cargo-deny
`unlicensed` error on all four members (both now fixed; details in the `vision-sidecar` skill).
*Why:* this is the general shape of the trap, not a one-off — a step that skips when a tool is
absent reports success, so "the gate is green" means nothing until you know which steps actually
ran. When you install a tool the repo tolerates missing, re-run the whole gate before assuming
your change is what broke it.

**2026-08-01 — `allowBuilds` cannot fetch the Electron binary, because there is no build to
allow.** Since v43, `electron`'s published `package.json` has **no `scripts` field at all** — the
`postinstall` that every guide and older answer refers to is gone. Adding `electron: true` to
`allowBuilds` in `pnpm-workspace.yaml` therefore does nothing at all, silently: `pnpm install`
reports success, `electron --version` works (that is the JS CLI shim), and the failure only
surfaces later as a missing `dist/` when something tries to *launch* it. Electron now ships an
`install-electron` bin instead, wired from the owning workspace project:

```jsonc
// apps/desktop/package.json
"scripts": { "postinstall": "install-electron", ... }
```

A workspace project's own lifecycle scripts are not gated by `allowBuilds`, so this runs on a
fresh clone — look for `apps/desktop postinstall$ install-electron` in the install output.

*Why:* verified by wiping every `node_modules` and reinstalling, which is the only test that
means anything here — a plain `pnpm install` over an already-populated tree is a no-op and will
happily "confirm" a fix that does not work. Use the same wipe-and-reinstall check for any
postinstall change.

**2026-08-01 — lefthook owns `pre-push`, so `git lfs install` silently loses.** It refuses to
overwrite an existing hook and exits with instructions most people skip; the clean/smudge filters
still get installed, so LFS *looks* fine — files check out and commit correctly — but nothing
uploads the objects on push, and the pointers land in the remote alone. The fix is a lefthook
command, not a hand-patched `.git/hooks/pre-push` (which `pnpm setup` regenerates):

```yaml
pre-push:
  commands:
    lfs:
      use_stdin: true
      run: git lfs pre-push {1} {2}
```

Both halves are load-bearing and neither is obvious: `git lfs pre-push` needs the hook's argv
(remote name, URL) *and* reads the ref updates from **stdin**, which lefthook does not forward
unless you ask. Without `use_stdin` it runs, reports success, and uploads nothing.

*Why:* verified end to end against a local bare remote rather than assumed — the failure mode
here is a hook that passes loudly while doing nothing, which no one notices until a fixture is
missing from someone else's clone. If you change this, test it the same way: push a tracked
binary to a scratch remote and confirm the object appears under its `lfs/objects/`.

**2026-08-01 — Prettier does not format markdown here, deliberately.** `*.md` is in
`.prettierignore`; markdownlint owns it. *Why:* Prettier pads every table cell to the widest
row, which turns the wide tables in the design docs into 700-column lines, and reflowing prose
someone else hand-wrapped produces huge diffs that collide with parallel work. If you find
markdown that looks unformatted, that is why — leave it.

**2026-08-01 — verifying a boundary rule needs the dependency to actually be installed.** The
recipe in the bullet above ("write a violating file, run `pnpm exec eslint`, confirm the error") is
necessary but not sufficient for a *cross-package* rule: with no dependency declared, the import
does not resolve and the rule reports success on a file written specifically to violate it. Add the
dep to the package's `package.json`, `pnpm install`, lint, confirm the error, then revert both.
*Why:* this is how the correction above was found — the rule looked verified and was not.

**2026-08-01 — `ls docs/design/` at the start of a task is not the same as `git status`, and the gap
is where duplicated work lives.** A task to build a hero knowledge library was started against a
`docs/design/` listing that did not contain the 36 KB design doc for the same
feature, with three Accepted ADRs, sitting **untracked** in the working tree and landing mid-session
from parallel work. The result was a second design note, a second ADR-0023, and an implementation
that violated two ADRs nobody had told it about. *Why:* `docs/README.md` referenced the doc the whole
time. Before writing a design note or claiming an ADR number, run `git status` and read the index —
untracked files are invisible to a directory listing you took ten minutes ago, and on this repo
"another agent is mid-task on the same thing" is the normal case, not the unlucky one.

**2026-08-01 — an ADR number is not claimable from `ls docs/adr/` either, if the competing file is
untracked.** Two `0026-*.md` files existed briefly. The convention above ("claim immediately before
you commit") assumes the numbers you can see are the numbers that exist. Check `git status` for
untracked ADRs at the same moment, and when two designs converge, keep the one the *other* documents
already link to — the deferred ADRs and the design doc had been rewritten to point at a specific
filename, so the choice was already made by the inbound links rather than by which was written first.

## See also

`REPO_SKELETON.md` §2 (layout), §8 (scripts), §9 (working agreements), §13 (skills).

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

**2026-08-02 — `git log --all` searches nothing if you never fetched, and says so confidently.**
A clone here can sit on a `main` that is several commits behind `origin/main` with **no
remote-tracking refs at all** — `git branch -a` shows only `main` and a bare `origin/HEAD`. In that
state `git log --all -S 'someSymbol'`, `git ls-files`, and `git cat-file -p HEAD:path` all return
empty for code that exists on the remote, and empty reads as proof of absence. Three separate
searches agreed the file had never existed; `git fetch --all` produced it immediately, along with
two branches nobody mentioned. *Why:* the "pull before you start" rule above is not just about
merge conflicts — an unfetched clone makes *absence* unfalsifiable. Before reporting that something
is missing or was never written, run `git fetch --all` and say in the report that you did.

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

**2026-08-01 — `packages/*` pointing `exports` at `src/*.ts` works until something *runs* it.**
Nine steps of the scaffolding order never loaded a package at run time — Vitest and `tsc` both read
source — so nobody noticed that Node cannot: under NodeNext the code writes `./foo.js` for
`./foo.ts`, so `packages/context/src/index.ts` importing `./common/timers.js` is
`ERR_MODULE_NOT_FOUND` the first time Electron main imports the package. Every manifest now exports
three conditions per subpath (`riki-source` + `types` → `src`, `default` → `dist`), and
`vitest.workspace.ts` sets `resolve.conditions` on all five projects. **Copy that shape into any
new package**; ADR-0025 has the reasoning.

The check that means anything: `rm -rf packages/<name>/dist` and run the suite. If it still passes,
tests are reading source. If a *new Vitest project* is added without `resolve.conditions`, it will
silently assert against the last build instead — which passes, and is wrong in a way no failure
reveals.

**2026-08-02 — `packages/realtime` emitted to `dist/src/`, and nothing could have noticed until a
value was imported.** ADR-0025 has every package export three conditions per subpath, with
`default` at `./dist/index.js` for Node. Nine of the ten packages set `rootDir: "src"` and emit
exactly that. `packages/realtime` set `rootDir: "."` — deliberately, so its `test/` directory
belonged to a project ESLint could lint — and therefore emitted `dist/src/index.js`. Its own
tsconfig said the deeper path was "inert because consumers import `main: ./src/index.ts`", which
was true only while every consumer imported **types**: `tsc` and Vitest read source, so the whole
gate passes. The first runtime `import { ApiKey } from '@riki/realtime'` in Electron main is
`ERR_MODULE_NOT_FOUND`.

The fix is a second project (`packages/realtime/tsconfig.test.json`, the same shape
`apps/desktop/tsconfig.test.json` already uses) so `rootDir` can be `"src"` like everywhere else. *Why:* the check that means
anything is not `tsc` — it is `node -e "import('@riki/<name>')"` from `apps/desktop`, which is four
seconds and the only thing that exercises the `default` condition. Run it for every package you add
or whose tsconfig you touch:

```sh
cd apps/desktop && for p in config context events gsi log-tail protocol realtime world-model; do
  node -e "import('@riki/$p').then(()=>console.log('OK  $p')).catch(e=>console.log('FAIL $p', e.message))"
done
```

**2026-08-02 — `packages/protocol` is no longer a skeleton, and `zod` is its first dependency.**
Until now no `packages/*` manifest had an external dependency at all, so nothing had exercised
pnpm's strict `node_modules` from a workspace package. Two things follow: a root-level script
cannot `import 'zod'` (resolve it through `createRequire` from the package that declares it), and
anything a package compiles to must sit *under* that package or its own imports stop resolving. The
`protocol` skill has the details. *Why:* the three packages that still export `{}` are
`packages/config` and `packages/telemetry`; check `src/index.ts` before assuming either exists.

**2026-08-01 — three "landed" packages were skeletons, and the scaffolding table did not say so.**
`packages/config`, `packages/telemetry` and `packages/protocol` all export `{}`. §10's table marks
steps 4, 5 and 5b as landed and is silent on 2 and 3, which reads as "fine" rather than "not
started". That silence cost real time on step 6, because two lint rules point *at* those packages:
`process.env` is readable only in `packages/config` and `console.*` only in `packages/telemetry`,
so the shell can read no environment variable and emit no log line. Both rules are right and
neither should be worked around — but budget for it, and check `src/index.ts` for `export {}`
before assuming a dependency exists.

**2026-08-01 — the last mile of a step is running the thing, and it finds what tests cannot.**
Step 6 was green — lint, typecheck, 960 tests — while containing a deadlock that stopped the app
before it bound a socket, an unhandled rejection that hid the deadlock, and a data directory named
`~/.config/@riki/desktop` because nothing called `app.setName`. None of the three is reachable from
a unit test: they are facts about Electron's event ordering, `Promise.prototype.then`'s two-argument
form, and a default derived from `package.json`. Under a headless sandbox that is
`xvfb-run -a pnpm dev`, then curl the GSI listener (see the `game-state` skill). *Why:* "all tests
pass" and "it starts" are different claims, and only one of them is what the step promised.

## See also

`REPO_SKELETON.md` §2 (layout), §8 (scripts), §9 (working agreements), §13 (skills).

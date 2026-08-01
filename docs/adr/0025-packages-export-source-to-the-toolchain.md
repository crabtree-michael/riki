# ADR-0025: Packages export source to the toolchain and `dist` to Node

**Status:** Accepted
**Date:** 2026-08-01

## Context

Every `packages/*` manifest pointed `main`, `types` and `exports` at `./src/index.ts`. That is what
makes Vitest and `tsc` read the working tree: a change in `packages/world-model` is visible to
`apps/desktop`'s tests immediately, with no build step and no watcher, which is most of why the
repo has been pleasant to work in for nine steps of the scaffolding order.

It also cannot survive contact with a runtime. Node does not execute TypeScript, and under NodeNext
the codebase writes `./foo.js` for `./foo.ts` — so the first time anything actually *imported* a
package at run time, resolution landed on `packages/context/src/index.ts`, which imports
`./common/timers.js`, which does not exist. This was invisible until REPO_SKELETON §10 step 6,
because until then nothing outside the type checker and the test runner ever loaded a package.
`pnpm dev` was the first thing that did, and it failed with `ERR_MODULE_NOT_FOUND` before
`app.whenReady()`.

## Decision

Every package exports three conditions for every subpath. `riki-source` and `types` point at
`src/*.ts`; `default` points at `dist/*.js`. `vitest.workspace.ts` sets
`resolve: { conditions: ['riki-source'] }` on all five projects, and `tsc` and
`eslint-import-resolver-typescript` take `types`. Node — and therefore Electron main — takes
`default` and gets the output of `tsc --build`, which `pnpm dev` runs first.

## Consequences

Tests, typecheck and lint keep reading source with no build step, which was the property worth
protecting. Electron main runs compiled JavaScript with resolvable specifiers, and needs no
bundler to do it.

The costs are real and both are about the extra condition being easy to forget:

- **A new package that copies the old one-line `exports` will work everywhere except at run time**,
  and will fail only when something launches the app. §2.1 states the shape for exactly this
  reason.
- **`resolve.conditions` is per Vitest project.** A sixth project added without it silently starts
  asserting against the last `dist/` rather than the working tree — which passes, and is wrong in a
  way no test failure reveals. The check is one line: delete a `dist/` and confirm the suite still
  runs.

`dist/` is now load-bearing for `pnpm dev` rather than being a typecheck artefact, so a stale build
is a real failure mode. `pnpm dev` runs `tsc --build` first to keep that from being a manual step.

## Alternatives rejected

**Bundle the main process with esbuild or Vite.** The standard Electron answer, and what
REPO_SKELETON §8.1's "Electron + Vite HMR" anticipates. Rejected *for now*, not on the merits: it
adds a build system and a dependency to solve a problem three lines of `exports` already solve, and
the renderer is three hand-written ES modules with nothing to bundle. This inverts the day the
renderer grows a framework — at which point Vite owns both halves and the `default` condition
becomes redundant rather than wrong.

**Point `exports` at `dist` unconditionally and build before testing.** Simple, standard, and it
throws away the property that matters: every test run would depend on a build being current, and a
stale one produces passing tests about code that is no longer there.

**`NODE_OPTIONS=--conditions=riki-source` when launching Electron.** Would let Node read source
too — except that Node still cannot execute TypeScript, so it solves nothing. Recorded because it
looks like the obvious symmetric answer and is not.

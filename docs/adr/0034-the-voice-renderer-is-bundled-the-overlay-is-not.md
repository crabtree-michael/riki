# ADR-0034: The voice renderer is bundled; the overlay is not

**Status:** Accepted
**Date:** 2026-08-02

## Context

`REPO_SKELETON.md` §8.1 describes `pnpm dev` as "Electron + Vite HMR" and the repo has
deliberately not got there: `scripts/copy-renderer-assets.mjs` says so in its header, on the
grounds that "the renderer is three hand-written ES modules with no dependencies, and a copy is the
whole build". That has been right for every renderer so far.

[ADR-0010](0010-dedicated-voice-window.md) adds one that is not like the others. The voice window
hosts the microphone, the Web Audio graph and the peer connection, which means it hosts
`@riki/audio` and `@riki/realtime` — and it decodes what crosses the preload bridge, which means
`@riki/protocol` and zod. A browser cannot resolve `import { createCaptureGraph } from
'@riki/audio'`. The failure is a `TypeError: Failed to resolve module specifier` in a window that is
never shown, with no DevTools open, in an app whose whole design is to be invisible until needed.

Three ways out were available.

## Decision

**esbuild bundles the voice renderer only, from `tsc`'s output.** `pnpm dev` runs
`tsc --build` → `copy-renderer-assets` → `bundle` → `electron .`, and
`apps/desktop/dist/renderer/voice/bundle.js` is what the document loads. The overlay renderer is
untouched and still loads `tsc`'s output directly.

Two properties of that arrangement are the reason it is this and not something else:

- **It bundles the compiled JavaScript, not the TypeScript.** Pointing esbuild at
  `src/renderer/voice/index.ts` would work and would quietly move the renderer's type checking out
  of `tsc --build` into a tool that does not type check. `pnpm typecheck` stays the only thing that
  decides whether the renderer compiles.
- **esbuild resolves the `default` export condition, not `riki-source`** ([ADR-0025](0025-packages-export-source-to-the-toolchain.md)).
  It bundles `packages/*/dist/*.js`, which `tsc --build` has already validated, rather than source
  it would have to compile itself.

## The second thing it turned out to be for

Launching the app after this landed surfaced a bug that had been there since step 6 and that
nothing could have caught: **the overlay's preload script had never loaded.** Electron loads a
preload as **CommonJS**, `apps/desktop/package.json` is `"type": "module"`, and `tsc` emits ESM — so
`dist/preload/index.js` failed with `SyntaxError: Cannot use import statement outside a module`,
reported to the *renderer's* console, which nothing reads. Main started, bound its socket, and ran
the entire coaching pipeline; `window.rikiOverlay` was simply undefined.

So `scripts/bundle.mjs` emits both preloads as `.cjs` as well, with `electron` marked external. Same
tool, same reason — a compiled artefact whose module format does not match its loader — and it is
why the script is named `bundle.mjs` rather than after the renderer.

## Consequences

- One build-time devDependency that never ships. esbuild is ~9 MB installed and the bundle step is
  under 100 ms, so `pnpm dev` does not get noticeably slower.
- The voice window keeps `sandbox: true` and `contextIsolation: true`. This is the property the
  rejected alternatives cost, and it is the one worth paying for.
- **The two renderers now build differently, which is a trap.** A developer who adds a `@riki/*`
  import to the *overlay* renderer will get the same unresolved-specifier failure and no
  explanation. The overlay is forbidden from importing `@riki/*` by a lint rule
  (`overlay-architecture.md` §11.2), so the rule now has a second reason to exist and the lint
  message is the place that failure gets explained.
- When Vite lands it replaces this script and `copy-renderer-assets.mjs` together, and both go
  away. Nothing here is meant to survive that. The **preload** half must survive it in some form,
  though: the CommonJS requirement is Electron's and does not go away with the bundler.
- `test/repo-hygiene.test.ts` pins the two shapes that would silently regress — `pnpm dev` bundling
  before it launches, and both preload paths ending in `.cjs`. Neither is a substitute for running
  the app, which is what actually found this; the Playwright harness is still outstanding.
- `index.html`'s CSP for this window is one directive looser than the overlay's —
  `connect-src https://api.openai.com` for the SDP exchange. That is a consequence of the window,
  not of the bundler, but it is the other way this document differs from the overlay's and the two
  should be read together.

## Alternatives rejected

- **An import map in the document.** No new dependency, and it needs one entry per package plus
  every transitive one (zod), pointing at paths outside `apps/desktop/dist` that a packaged asar
  would not have. It works in a dev run and breaks at packaging, which is the worst time to find
  out.
- **Run the voice implementation in the preload script with `sandbox: false`.** Genuinely tempting:
  a preload with Node integration resolves workspace packages natively, still has `navigator`,
  `AudioContext` and `RTCPeerConnection`, and needs no bundler at all. Rejected because
  `sandbox: false` on any window in an Electron app is a thing that gets copied to the next window
  by someone who does not read this file, and because it puts the whole voice implementation in a
  directory whose stated job is to be a three-function bridge.
- **Adopt Vite now.** The correct end state and a much larger change than this ticket, touching the
  overlay's build, the asset copy, the dev loop and the packaging step that does not exist yet. The
  bundle script is forty lines and deletes cleanly.

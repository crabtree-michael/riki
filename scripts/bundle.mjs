#!/usr/bin/env node
// Bundles the two things `tsc` output cannot be loaded as: the voice renderer, and both preload
// scripts (ADR-0034).
//
// ## The voice renderer, because a browser cannot resolve a bare specifier
//
// The overlay renderer needs nothing like this: it is hand-written ES modules with no dependencies,
// so `tsc` output plus `copy-renderer-assets.mjs` is the whole build. The voice renderer imports
// `@riki/audio`, `@riki/realtime` and `@riki/protocol` (ADR-0010), and without a bundler the window
// loads, throws `Failed to resolve module specifier "@riki/audio"`, and shows nothing — because
// there is nothing to show.
//
// ## The preloads, because Electron loads them as CommonJS
//
// `apps/desktop/package.json` is `"type": "module"` and `tsc` emits ESM, so a preload at
// `dist/preload/index.js` fails with **`SyntaxError: Cannot use import statement outside a
// module`** — reported to the *renderer's* console, which nothing reads, while main carries on
// perfectly happily. The overlay's bridge was never installed and nobody noticed for a whole step:
// `window.rikiOverlay` was simply undefined, and the app still started, still bound its socket and
// still ran the entire coaching pipeline.
//
// So each preload is bundled to `.cjs`, which is unambiguous to both Node and Electron. **Every
// preload belongs in the list below** — a window whose preload is missing from it fails exactly the
// way the overlay's did, which is to say invisibly.
//
// ## It bundles the *compiled* output, not the TypeScript
//
// esbuild would happily read `src/**/*.ts`, and that would quietly move type checking out of
// `tsc --build` into a tool that does not type check at all. `tsc` runs first; esbuild's only job
// is module resolution and format.
//
// `conditions` is left at esbuild's default so it takes each package's `default` export condition
// (`dist/*.js`, already validated by `tsc`) rather than `riki-source` (ADR-0025).

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Resolved against this file, not the cwd: `pnpm dev` runs from `apps/desktop` and a developer
// runs from the repo root, and a relative path would fail in one of the two.
const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'apps/desktop/dist');

/** `electron` is provided by the runtime and must never be bundled into a preload. */
const ELECTRON_EXTERNAL = ['electron'];

const TARGETS = [
  {
    what: 'voice renderer',
    entry: join(DIST, 'renderer/voice/index.js'),
    outfile: join(DIST, 'renderer/voice/bundle.js'),
    format: 'esm',
    platform: 'browser',
    target: 'chrome130',
    external: [],
  },
  {
    what: 'overlay preload',
    entry: join(DIST, 'preload/index.js'),
    outfile: join(DIST, 'preload/index.cjs'),
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ELECTRON_EXTERNAL,
  },
  {
    what: 'voice preload',
    entry: join(DIST, 'preload/voice.js'),
    outfile: join(DIST, 'preload/voice.cjs'),
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ELECTRON_EXTERNAL,
  },
  {
    what: 'inspector preload',
    entry: join(DIST, 'preload/debug.js'),
    outfile: join(DIST, 'preload/debug.cjs'),
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ELECTRON_EXTERNAL,
  },
];

for (const target of TARGETS) {
  if (!existsSync(target.entry)) {
    console.error(
      `[bundle] ${target.entry} does not exist. Run \`tsc --build\` first — this bundles the\n` +
        `[bundle] compiled output, not the TypeScript source.`,
    );
    process.exit(1);
  }

  const result = await build({
    entryPoints: [target.entry],
    outfile: target.outfile,
    bundle: true,
    format: target.format,
    platform: target.platform,
    external: target.external,
    target: target.target,
    // Not minified: this ships in a developer build, and a readable stack trace from a process
    // with no DevTools open is worth more than the bytes.
    sourcemap: true,
    logLevel: 'warning',
  });

  if (result.errors.length > 0) process.exit(1);
  console.log(`[bundle] ${target.what} → ${target.outfile.slice(ROOT.length + 1)}`);
}

#!/usr/bin/env node
// Copies the renderer's non-TypeScript files into `dist/`, next to the JavaScript `tsc` emitted.
//
// `tsc` copies no assets, and `index.html` loads `./index.js` and `./overlay.css` **relative to
// itself** — so a window pointed at `src/renderer/overlay/index.html` finds an `index.ts` it
// cannot execute and a stylesheet it can, which renders an unstyled empty div and no error. The
// document and the code it loads have to end up in the same directory, and this is the step that
// puts them there.
//
// Deliberately not a bundler. REPO_SKELETON.md §8.1 describes `pnpm dev` as "Electron + Vite HMR",
// and when Vite lands it owns this and this file goes away. Until then the renderer is three
// hand-written ES modules with no dependencies, and a copy is the whole build.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Resolved against this file, not the cwd: `pnpm dev` runs it from `apps/desktop` and a developer
// runs it from the repo root, and a relative path would silently copy nothing in one of the two.
const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'apps/desktop/src/renderer');
const OUT = join(ROOT, 'apps/desktop/dist/renderer');

/** Everything `tsc` does not emit. */
const ASSETS = /\.(html|css|svg|png|woff2?)$/;

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (ASSETS.test(entry)) found.push(path);
  }
  return found;
}

if (!existsSync(SRC)) {
  console.error(`[assets] ${SRC} does not exist.`);
  process.exit(1);
}

let count = 0;
for (const file of walk(SRC)) {
  const target = join(OUT, relative(SRC, file));
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(file, target);
  count += 1;
}

console.log(`[assets] copied ${count} renderer file(s) into ${OUT}`);

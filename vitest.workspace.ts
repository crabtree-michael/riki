import { defineWorkspace } from 'vitest/config';

/**
 * One Vitest project per workspace member (REPO_SKELETON.md §5.1).
 *
 * Tests are colocated as `*.test.ts` next to the unit under test; integration tests live in
 * a package's `test/` directory. Playwright owns `apps/desktop/e2e` and is run separately by
 * `pnpm test:e2e`, so it is excluded here.
 *
 * ## `riki-source`
 *
 * Every `packages/*` manifest exports three conditions for each subpath: `riki-source` and `types`
 * point at `src/*.ts`, and `default` points at `dist/*.js`. Vitest and tsc take the first two and
 * run against source, which is what makes a change to a package visible to its consumers' tests
 * with no build step. Node — and therefore Electron main — takes `default`, because Node cannot
 * execute TypeScript and `src/index.ts` importing `./common/timers.js` resolves to a file that
 * only exists after `tsc --build`.
 *
 * Without the condition below Vitest would follow `default` too, and every test in the repo would
 * silently start asserting against the last build rather than the working tree.
 */
const conditions = ['riki-source'];

export default defineWorkspace([
  {
    resolve: { conditions },
    test: {
      name: 'repo',
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    resolve: { conditions },
    test: {
      name: 'packages',
      include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    resolve: { conditions },
    test: {
      name: 'desktop',
      include: [
        'apps/desktop/src/main/**/*.test.ts',
        'apps/desktop/src/preload/**/*.test.ts',
        'apps/desktop/src/shared/**/*.test.ts',
        'apps/desktop/test/**/*.test.ts',
      ],
      exclude: ['apps/desktop/e2e/**'],
      environment: 'node',
    },
  },
  {
    // The chip's view code needs a document to write into, and an in-memory one is enough — this
    // is still Tier 1 by REPO_SKELETON.md §5.2's rule: no game, no microphone, no GPU, no window.
    // Tier 5 (Playwright on a real Electron build) remains the only place a window launches.
    resolve: { conditions },
    test: {
      name: 'desktop-renderer',
      include: ['apps/desktop/src/renderer/**/*.test.ts'],
      environment: 'happy-dom',
    },
  },
  {
    resolve: { conditions },
    test: {
      name: 'tools',
      include: ['tools/*/src/**/*.test.ts'],
      environment: 'node',
    },
  },
]);

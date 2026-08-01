import { defineWorkspace } from 'vitest/config';

/**
 * One Vitest project per workspace member (REPO_SKELETON.md §5.1).
 *
 * Tests are colocated as `*.test.ts` next to the unit under test; integration tests live in
 * a package's `test/` directory. Playwright owns `apps/desktop/e2e` and is run separately by
 * `pnpm test:e2e`, so it is excluded here.
 */
export default defineWorkspace([
  {
    test: {
      name: 'repo',
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'packages',
      include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'desktop',
      include: ['apps/desktop/src/**/*.test.ts', 'apps/desktop/test/**/*.test.ts'],
      exclude: ['apps/desktop/e2e/**'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'tools',
      include: ['tools/*/src/**/*.test.ts'],
      environment: 'node',
    },
  },
]);

// Flat ESLint config for the Riki workspace.
//
// Beyond the ordinary rules, this file encodes design decisions that REPO_SKELETON.md §6.2
// says must hold without anyone remembering them: module boundaries, one place that reads
// `process.env`, one place that calls `console.*`, and no raw colour literals in the renderer.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/** Directories that hold no source we lint. */
const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/out/**',
  '**/target/**',
  '**/coverage/**',
  '**/*.generated.ts',
  'fixtures/**',
];

/**
 * Boundary element types, matched most-specific-first. `mode: 'full'` matches the whole
 * path so the `apps/desktop/src/*` entries can be distinguished from the app as a whole.
 */
const BOUNDARY_ELEMENTS = [
  // Command handlers are leaves (agent-command-execution-architecture.md §2.3). Listed before
  // `package` so the more specific pattern wins — elements match most-specific-first.
  {
    type: 'context-handler',
    mode: 'full',
    pattern: 'packages/context/src/tools/handlers/*.ts',
  },
  { type: 'desktop-main', mode: 'full', pattern: 'apps/desktop/src/main/**' },
  { type: 'desktop-preload', mode: 'full', pattern: 'apps/desktop/src/preload/**' },
  { type: 'desktop-renderer', mode: 'full', pattern: 'apps/desktop/src/renderer/**' },
  { type: 'desktop-shared', mode: 'full', pattern: 'apps/desktop/src/shared/**' },
  { type: 'app', mode: 'full', pattern: 'apps/*/**' },
  { type: 'package', mode: 'full', pattern: 'packages/*/**', capture: ['name'] },
  { type: 'tool', mode: 'full', pattern: 'tools/*/**' },
];

export default tseslint.config(
  { ignores: IGNORES },

  eslint.configs.recommended,

  // Type-aware linting for TypeScript sources only.
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level TS config files belong to no package project.
          allowDefaultProject: ['vitest.workspace.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // REPO_SKELETON.md §6.2: the Realtime integration is an async event bus; a dropped
      // promise there surfaces as a hung session, the hardest bug class here to reproduce.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Module boundaries (REPO_SKELETON.md §6.2).
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'tools/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': BOUNDARY_ELEMENTS,
      'boundaries/include': ['apps/**', 'packages/**', 'tools/**'],
      // Boundary rules only fire on imports that resolve. Under NodeNext the codebase
      // writes `./foo.js` for `./foo.ts`, which the default resolver cannot follow — so
      // without this the rules silently pass on exactly the imports they exist to catch.
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: 'tsconfig.json' },
      },
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              // Business logic stays testable: packages never reach into the app.
              from: ['package'],
              disallow: [
                'app',
                'desktop-main',
                'desktop-preload',
                'desktop-renderer',
                'desktop-shared',
              ],
              message: 'packages/* may not import from apps/* — business logic stays testable.',
            },
            {
              // The world model must not know it is feeding an LLM: state and conversation
              // rates are decoupled by design (dota2-state-capture-design.md §1).
              from: [['package', { name: 'world-model' }]],
              disallow: [['package', { name: 'realtime' }]],
              message: 'packages/world-model may not import packages/realtime.',
            },
            {
              // The preload bridge is the only path from renderer to main.
              from: ['desktop-renderer'],
              disallow: ['desktop-main'],
              message: 'Renderer code may not import from main/ — go through the preload bridge.',
            },
            {
              // The load-bearing rule for Tier 3 (agent-command-execution-architecture.md §2.3).
              // `@riki/context` importing `@riki/realtime` would be the natural way to submit a
              // tool result, and it would pull the GA-schema trap, the session lifecycle and the
              // openai SDK into the package that is meant to be a pure function of a snapshot.
              // Game facts arrive only through `WorldModelReader`.
              //
              // This is an `element-types` rule and not a `boundaries/external` one: a workspace
              // import written by name resolves — `eslint-import-resolver-typescript` is
              // configured below — so boundaries sees `packages/realtime/**` and matches it as an
              // element. `external` only covers real node_modules packages such as `electron`.
              from: [['package', { name: 'context' }], 'context-handler'],
              disallow: [
                ['package', { name: 'realtime' }],
                ['package', { name: 'gsi' }],
                ['package', { name: 'log-tail' }],
              ],
              message:
                'packages/context reads the world model through a port and speaks no vendor ' +
                'vocabulary — the Realtime translation lives in the composition root adapter.',
            },
            {
              // A command handler that called another would be a command whose failure paths are
              // somebody else's and whose deadline is spent twice
              // (agent-command-execution-architecture.md §2.3). The aggregator lives one directory
              // up, in tools/all-handlers.ts, so this rule needs no exception.
              from: ['context-handler'],
              disallow: ['context-handler'],
              message: 'A command handler may not import another command handler.',
            },
          ],
        },
      ],
      // Workspace packages are imported by name (`@riki/realtime`), which boundaries treats
      // as external rather than as an element — so the cross-package rules have to be
      // expressed here as well as in element-types above. element-types still covers
      // relative imports across directories within an element.
      'boundaries/external': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              from: [
                'app',
                'package',
                'tool',
                'desktop-main',
                'desktop-preload',
                'desktop-renderer',
                'desktop-shared',
              ],
              disallow: ['openai'],
              message: 'The openai SDK may only be imported by packages/realtime.',
            },
            {
              from: [['package', { name: 'realtime' }]],
              allow: ['openai'],
            },
            {
              from: ['package'],
              disallow: ['@riki/desktop'],
              message: 'packages/* may not import from apps/* — business logic stays testable.',
            },
            {
              from: [['package', { name: 'world-model' }]],
              disallow: ['@riki/realtime'],
              message:
                'packages/world-model may not import packages/realtime — the model must not know it is feeding an LLM.',
            },
            {
              // `packages/context` must run in a bare vitest process, which is what makes almost
              // all of Tier 3 testable with no game and no session (§2.3, §13). The cross-package
              // half of this rule is in `element-types` above — see the note there for why.
              from: [['package', { name: 'context' }], 'context-handler'],
              disallow: ['electron'],
              message:
                'packages/context may not import electron — it must run in a bare vitest process.',
            },
          ],
        },
      ],
    },
  },

  // `process.env` is readable in exactly one package. This is what keeps the API key
  // (REPO_SKELETON.md §7.1) traceable to a single auditable file.
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: ['packages/config/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Only packages/config may read process.env (REPO_SKELETON.md §6.2). Take injected config instead.',
        },
      ],
    },
  },

  // Logs pass through packages/telemetry so redaction rules apply before any sink.
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: ['packages/telemetry/**'],
    rules: {
      'no-console': 'error',
    },
  },

  // Accent colours come from the token module (ui-design.md §4.2) so the "no red" rule
  // has exactly one place to be enforced.
  {
    files: ['apps/desktop/src/renderer/**/*.ts', 'apps/desktop/src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message: 'No raw colour literals in renderer code — use the design token module.',
        },
      ],
    },
  },

  // Tests and dev-only tooling: relax the rules that exist to protect the shipping path.
  {
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/e2e/**/*.ts', 'tools/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Repo chores are plain Node scripts, deliberately outside the TypeScript projects.
  {
    files: ['scripts/**/*.mjs', '*.js', '*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
);

#!/usr/bin/env node
// Placeholder for a canonical script name (REPO_SKELETON.md §8.1) whose implementation is
// still ahead of us in the scaffolding order (§10).
//
// The names are fixed now so nobody invents a second one for the same action. Running one
// fails with a pointer at what has to land first, rather than a confusing missing-script error.

const [command, blockedOn] = process.argv.slice(2);

console.error(`\n  \`pnpm ${command}\` is not scaffolded yet.`);
console.error(`  Blocked on: ${blockedOn}\n`);
console.error(
  '  Until then: `pnpm test`, `pnpm lint`, `pnpm typecheck` and `pnpm check` all work.\n',
);
process.exit(1);

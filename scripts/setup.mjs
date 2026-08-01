#!/usr/bin/env node
// One command for a fresh clone (REPO_SKELETON.md §8.1).
//
// Deliberately tolerant: a missing optional tool prints a notice and moves on, because the
// point of this script is that a new agent or developer gets to a working repo in one step.

import { copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const step = (msg) => console.log(`\n▸ ${msg}`);
const note = (msg) => console.log(`  ${msg}`);

/** Run a command; return true on success, false if it is missing or failed. */
function run(cmd, args, { optional = false } = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error) {
    note(optional ? `${cmd} not installed — skipped.` : `${cmd} not found.`);
    return false;
  }
  return result.status === 0;
}

step('Installing Node dependencies');
run('pnpm', ['install']);

step('Fetching LFS fixtures');
if (!run('git', ['lfs', 'pull'], { optional: true })) {
  note('Frame fixtures are unavailable; tests that need them will skip with a message.');
}

step('Generating protocol types');
run('node', ['scripts/codegen.mjs']);

step('Installing git hooks');
if (!run('pnpm', ['exec', 'lefthook', 'install'], { optional: true })) {
  note('lefthook is not a dependency yet — hooks not installed. Run `pnpm check` manually.');
}

step('Checking .env');
if (existsSync('.env')) {
  note('.env already exists — left untouched.');
} else {
  copyFileSync('.env.example', '.env');
  note('Created .env from .env.example.');
}
console.log(
  '\n  One line still needs you, and only for live voice:\n' +
    '    RIKI_OPENAI_API_KEY=sk-...\n' +
    '  Leave it blank to run fixtures-only — `pnpm test` and `pnpm dev:replay` need no key.\n' +
    '  See REPO_SKELETON.md §7.1.\n',
);

#!/usr/bin/env node
// Markdown link check (REPO_SKELETON.md §6.1). Warn-only, deliberately: external links rot for
// reasons that are not our fault, and a dead third-party URL should never block a commit.
//
// Skips with a notice when lychee is not installed — it is a Rust binary most machines will not
// have, and it is the one part of the gate that is advisory rather than enforcing.

import { spawnSync } from 'node:child_process';

const probe = spawnSync('lychee', ['--version'], { stdio: 'ignore' });
if (probe.error) {
  console.warn('[lychee] not installed — skipping the link check. `cargo install lychee`.');
  process.exit(0);
}

const result = spawnSync('lychee', ['--no-progress', '--max-concurrency', '4', '**/*.md'], {
  stdio: 'inherit',
});

// Never fail the commit; report and move on.
if (result.status !== 0) {
  console.warn('[lychee] broken links above — warning only, commit not blocked.');
}
process.exit(0);

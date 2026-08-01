#!/usr/bin/env node
// Secret scan (REPO_SKELETON.md §6.1). Skips with a notice when gitleaks is not installed
// locally. CI would install it, but CI is not switched on yet (.github/workflows-pending/),
// so on a machine without gitleaks nothing is scanning pushes at all.

import { spawnSync } from 'node:child_process';

const probe = spawnSync('gitleaks', ['version'], { stdio: 'ignore' });
if (probe.error) {
  console.warn(
    '[gitleaks] not installed — skipping the local secret scan.\n' +
      '[gitleaks] See https://github.com/gitleaks/gitleaks. CI is not active yet, so nothing\n' +
      '[gitleaks] else is scanning this push.',
  );
  process.exit(0);
}

const result = spawnSync('gitleaks', ['git', '--no-banner', '--redact'], { stdio: 'inherit' });
process.exit(result.status ?? 1);

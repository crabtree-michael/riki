#!/usr/bin/env node
// Secret scan (REPO_SKELETON.md §6.1). Skips with a notice when gitleaks is not installed
// locally; CI installs it, so the gate is never actually optional.

import { spawnSync } from 'node:child_process';

const probe = spawnSync('gitleaks', ['version'], { stdio: 'ignore' });
if (probe.error) {
  console.warn(
    '[gitleaks] not installed — skipping the local secret scan.\n' +
      '[gitleaks] See https://github.com/gitleaks/gitleaks. CI runs it on every push.',
  );
  process.exit(0);
}

const result = spawnSync('gitleaks', ['git', '--no-banner', '--redact'], { stdio: 'inherit' });
process.exit(result.status ?? 1);

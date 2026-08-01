#!/usr/bin/env node
// Secret scan (REPO_SKELETON.md §6.1). Skips with a notice when gitleaks is not installed
// locally. There is no CI (ADR-0008), so on a machine without gitleaks nothing is scanning
// for secrets at all — this is the only pass there is.

import { spawnSync } from 'node:child_process';

// Extra args are forwarded, so pre-commit can pass `--staged` (scan what is about to be
// committed, ~0.3s) while pre-push re-scans the whole history as a backstop.
const args = process.argv.slice(2);

const probe = spawnSync('gitleaks', ['version'], { stdio: 'ignore' });
if (probe.error) {
  console.warn(
    '[gitleaks] not installed — skipping the local secret scan.\n' +
      '[gitleaks] See https://github.com/gitleaks/gitleaks. There is no CI, so nothing else\n' +
      '[gitleaks] is scanning for secrets.',
  );
  process.exit(0);
}

const result = spawnSync('gitleaks', ['git', '--no-banner', '--redact', ...args], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);

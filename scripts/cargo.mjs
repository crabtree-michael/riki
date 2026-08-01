#!/usr/bin/env node
// Run a cargo subcommand, or skip loudly when there is no Rust toolchain.
//
// The Rust sidecar is a real part of the build (REPO_SKELETON.md §1), but a TypeScript-only
// agent should still be able to run `pnpm check` end to end. Skipping with a visible notice
// is honest; failing on a missing toolchain would push people to stop running the gate.

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
if (probe.error) {
  console.warn(
    `[cargo] skipped \`cargo ${args.join(' ')}\` — no Rust toolchain on this machine.\n` +
      '[cargo] Install via https://rustup.rs to build and test crates/. There is no CI, so\n' +
      '[cargo] nothing else is compiling them either.',
  );
  process.exit(0);
}

const result = spawnSync('cargo', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);

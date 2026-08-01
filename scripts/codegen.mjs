#!/usr/bin/env node
// Regenerate JSON Schema + Rust types from packages/protocol (REPO_SKELETON.md §4).
//
// `--check` is the CI gate: it fails if regenerating produces a diff, which is how
// hand-edited generated Rust gets caught.
//
// packages/protocol is step 2 of the scaffolding order (§10) and has no schemas yet, so
// today this is a no-op. The script exists now so the command name and the CI job are
// stable, and whoever lands protocol only has to fill in the middle: generate into
// packages/protocol/generated and crates/riki-ipc/src/generated, then, under --check,
// fail if `git status --porcelain` reports either as dirty.

import { existsSync, readdirSync } from 'node:fs';

const SCHEMA_DIR = 'packages/protocol/src/schemas';

const hasSchemas = existsSync(SCHEMA_DIR) && readdirSync(SCHEMA_DIR).some((f) => f.endsWith('.ts'));

if (!hasSchemas) {
  console.log(`[codegen] no schemas in ${SCHEMA_DIR} yet — nothing to generate.`);
  process.exit(0);
}

console.error(
  '[codegen] schemas exist but the generator has not been implemented.\n' +
    '[codegen] See REPO_SKELETON.md §4: zod is the source of truth, JSON Schema is generated\n' +
    '[codegen] from it, and crates/riki-ipc types are generated from that.',
);
process.exit(1);

#!/usr/bin/env node
// Regenerate JSON Schema + Rust types from packages/protocol (REPO_SKELETON.md §4).
//
// zod is the source of truth. This script is the two arrows after it:
//
//     packages/protocol/src/schemas/*.ts
//              │  z.toJSONSchema
//              ▼
//     packages/protocol/generated/<name>.schema.json
//              │  emitRust (below)
//              ▼
//     crates/riki-ipc/src/generated/<name>.rs
//
// `--check` is the gate: it regenerates into memory and fails if the result differs from what is
// on disk, which is how a hand-edited generated file gets caught. It is deliberately a content
// comparison rather than `git status --porcelain` — that would also pass on a dirty tree that
// nobody has staged, and miss the case where someone edited generated Rust and never ran codegen.
//
// ## Why there is a TypeScript build in the middle
//
// The schemas are TypeScript and Node cannot execute them: under NodeNext the source writes
// `../version.js` for `../version.ts`, which type-stripping does not remap. So the package is
// compiled to `.codegen-tmp/` (gitignored) and imported from there. The compile is also a free
// correctness check — a schema file that does not typecheck never reaches the generator.
//
// ## The Rust emitter handles the subset we author, and shouts about the rest
//
// It covers exactly what `z.toJSONSchema` produces for the schemas in this repo: objects, string
// enums, arrays, primitives, `$ref`, and `oneOf` over objects discriminated by a `const` field.
// Anything else throws by name rather than emitting something plausible and wrong — a generator
// that silently degrades is worse than no generator, because the drift it produces looks like
// hand-written code.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(ROOT, 'packages/protocol/src/schemas');
const JSON_OUT_DIR = join(ROOT, 'packages/protocol/generated');
const RUST_OUT_DIR = join(ROOT, 'crates/riki-ipc/src/generated');
// Inside the package, not at the repo root: the compiled schemas still `import 'zod'`, and pnpm's
// node_modules is strict enough that they only resolve it from somewhere under packages/protocol.
const TMP_DIR = join(ROOT, 'packages/protocol/.codegen-tmp');

const CHECK = process.argv.includes('--check');

/**
 * One entry per schema module. `root` is the exported schema whose `$defs` become the generated
 * types; `name` is the file stem on both sides.
 */
const MODULES = [{ name: 'sidecar', root: 'SidecarProtocol' }];

// ---------------------------------------------------------------------------------------------

// `main` is invoked at the bottom of the file: the emitter's `const` templates below are in the
// temporal dead zone until then, and calling it from up here fails on the first schema.
async function main() {
  const hasSchemas =
    existsSync(SCHEMA_DIR) && readdirSync(SCHEMA_DIR).some((f) => f.endsWith('.ts'));

  if (!hasSchemas) {
    console.log(`[codegen] no schemas in ${SCHEMA_DIR} yet — nothing to generate.`);
    process.exit(0);
  }

  const compiled = compileProtocol();

  // zod is a dependency of packages/protocol, not of the workspace root, and pnpm's node_modules is
  // strict — so resolving it has to start from the package that declares it, not from this script.
  const { z } = await import(
    pathToFileURL(createRequire(join(ROOT, 'packages/protocol/package.json')).resolve('zod')).href
  );

  const outputs = [];

  for (const mod of MODULES) {
    const source = await import(pathToFileURL(join(compiled, 'schemas', `${mod.name}.js`)).href);
    const rootSchema = source[mod.root];
    if (rootSchema === undefined) {
      fail(`packages/protocol/src/schemas/${mod.name}.ts does not export ${mod.root}`);
    }

    const document = z.toJSONSchema(rootSchema, { target: 'draft-2020-12', io: 'output' });
    const schemaPath = join(JSON_OUT_DIR, `${mod.name}.schema.json`);
    outputs.push({
      path: schemaPath,
      // Prettier, for the same reason rustfmt runs below: `pnpm check` runs `prettier --check .`
      // over the whole tree, and generated output that Prettier disagrees with fails the gate on
      // every clean checkout.
      content: await prettify(`${JSON.stringify(document, null, 2)}\n`, schemaPath),
    });
    outputs.push({
      path: join(RUST_OUT_DIR, `${mod.name}.rs`),
      content: emitRust(document, mod, source.PROTOCOL_VERSION ?? source.CURRENT_PROTOCOL_VERSION),
    });
  }

  outputs.push({ path: join(RUST_OUT_DIR, 'mod.rs'), content: emitRustModIndex(MODULES) });

  rmSync(TMP_DIR, { recursive: true, force: true });

  // rustfmt is run when present so the committed output is what `cargo fmt --check` wants. The
  // emitter is written to be rustfmt-stable, so a machine without the toolchain produces the same
  // bytes — if that ever stops being true, this line is where the divergence starts.
  for (const out of outputs) {
    if (out.path.endsWith('.rs')) out.content = rustfmt(out.content);
  }

  let dirty = 0;
  for (const out of outputs) {
    const current = existsSync(out.path) ? readFileSync(out.path, 'utf8') : null;
    if (current === out.content) continue;
    dirty += 1;
    if (CHECK) {
      console.error(`[codegen] out of date: ${out.path.slice(ROOT.length + 1)}`);
    } else {
      mkdirSync(dirname(out.path), { recursive: true });
      writeFileSync(out.path, out.content);
      console.log(`[codegen] wrote ${out.path.slice(ROOT.length + 1)}`);
    }
  }

  if (CHECK && dirty > 0) {
    console.error(`[codegen] ${dirty} generated file(s) differ. Run \`pnpm codegen\` and commit.`);
    process.exit(1);
  }
  if (CHECK) console.log('[codegen] generated files are up to date.');
  else if (dirty === 0) console.log('[codegen] generated files were already up to date.');
}

// ---------------------------------------------------------------------------------------------
// TypeScript → importable JavaScript
// ---------------------------------------------------------------------------------------------

function compileProtocol() {
  const out = join(TMP_DIR, 'protocol');
  rmSync(TMP_DIR, { recursive: true, force: true });
  const result = spawnSync(
    'node',
    [
      join(ROOT, 'node_modules/typescript/bin/tsc'),
      '--project',
      join(ROOT, 'packages/protocol/tsconfig.json'),
      '--outDir',
      out,
      // A scratch build: no project references, no declarations, nothing to leave behind.
      '--composite',
      'false',
      '--declaration',
      'false',
      '--declarationMap',
      'false',
      '--sourceMap',
      'false',
      '--incremental',
      'false',
    ],
    { stdio: 'inherit', cwd: ROOT },
  );
  if (result.status !== 0) fail('packages/protocol does not compile — fix that first.');
  return out;
}

async function prettify(source, filepath) {
  // `resolve` lands on Prettier's CommonJS entry point, so the ESM namespace wraps the real
  // exports in `default`. Reaching through it is the difference between this working and
  // `prettier.format is not a function`.
  const module = await import(
    pathToFileURL(createRequire(join(ROOT, 'package.json')).resolve('prettier')).href
  );
  const prettier = module.default ?? module;
  const config = (await prettier.resolveConfig(filepath)) ?? {};
  return await prettier.format(source, { ...config, filepath });
}

function rustfmt(source) {
  const probe = spawnSync('rustfmt', ['--version'], { stdio: 'ignore' });
  if (probe.error) return source;
  const result = spawnSync('rustfmt', ['--edition', '2021', '--emit', 'stdout', '--quiet'], {
    input: source,
    encoding: 'utf8',
  });
  if (result.status !== 0) fail(`rustfmt rejected generated code:\n${result.stderr ?? ''}`);
  return result.stdout;
}

function fail(message) {
  console.error(`[codegen] ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// JSON Schema → Rust
// ---------------------------------------------------------------------------------------------

const HEADER = (name) => `// @generated by scripts/codegen.mjs from
// packages/protocol/generated/${name}.schema.json. DO NOT EDIT.
//
// zod is the source of truth (REPO_SKELETON.md §4). Hand-editing this file is the exact failure
// the generator exists to prevent: the two languages stop agreeing and nothing says so until a
// message crosses the boundary at runtime.
//
// Doc comments below are the \`describe()\` text from the schemas, which is prose about the
// protocol rather than Rust prose — \`doc_markdown\` would flag every field name in it.
#![allow(clippy::doc_markdown)]

use serde::{Deserialize, Serialize};
`;

function emitRustModIndex(modules) {
  const mods = modules.map((m) => `pub mod ${m.name};`).join('\n');
  const uses = modules.map((m) => `pub use ${m.name}::*;`).join('\n');
  return `// @generated by scripts/codegen.mjs. DO NOT EDIT.

${mods}

${uses}
`;
}

function emitRust(document, mod, protocolVersion) {
  const defs = document.$defs ?? {};
  const chunks = [HEADER(mod.name)];

  if (typeof protocolVersion === 'number') {
    chunks.push(
      `/// The wire version this build speaks. Generated from \`PROTOCOL_VERSION\` in
/// \`packages/protocol/src/version.ts\` so the two cannot drift.
pub const PROTOCOL_VERSION: u64 = ${protocolVersion};
`,
    );
  }

  for (const name of Object.keys(defs).sort()) {
    chunks.push(emitDef(name, defs[name]));
  }

  return `${chunks.join('\n')}`;
}

function emitDef(name, schema) {
  if (Array.isArray(schema.oneOf)) return emitTaggedEnum(name, schema);
  if (Array.isArray(schema.enum)) return emitUnitEnum(name, schema);
  if (schema.type === 'object') return emitStruct(name, schema);
  fail(`cannot generate Rust for $defs/${name}: unsupported schema shape`);
  return '';
}

const DERIVE = '#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]';

function emitStruct(name, schema) {
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(([key, prop]) =>
    emitField(key, prop, required.has(key)),
  );
  return `${doc(schema.description)}${DERIVE}
#[serde(rename_all = "camelCase")]
pub struct ${name} {
${fields.join('\n')}
}
`;
}

/**
 * `visibility` is empty inside an enum variant: a struct variant's fields inherit the enum's
 * visibility and `pub` there is a syntax error, not a redundancy.
 */
function emitField(key, prop, isRequired, visibility = 'pub ') {
  const inner = rustType(prop, key);
  const ty = isRequired ? inner : `Option<${inner}>`;
  const skip = isRequired ? '' : `    #[serde(skip_serializing_if = "Option::is_none")]\n`;
  return `${doc(prop.description, '    ')}${skip}    ${visibility}${snake(key)}: ${ty},`;
}

/** `oneOf` over objects that all carry the same `const` string property: a serde-tagged enum. */
function emitTaggedEnum(name, schema) {
  const tag = discriminator(name, schema.oneOf);
  const variants = schema.oneOf.map((option) => {
    const value = option.properties[tag].const;
    const required = new Set(option.required ?? []);
    const fields = Object.entries(option.properties)
      .filter(([key]) => key !== tag)
      .map(([key, prop]) =>
        emitField(key, prop, required.has(key), '').replace(/^ {4}/gm, '        '),
      );
    const body = fields.length === 0 ? '' : ` {\n${fields.join('\n')}\n    }`;
    return `    #[serde(rename = "${value}")]\n    ${pascal(value)}${body},`;
  });
  return `${doc(schema.description)}${DERIVE}
#[serde(tag = "${tag}", rename_all_fields = "camelCase")]
pub enum ${name} {
${variants.join('\n')}
}
`;
}

function discriminator(name, options) {
  const candidates = Object.keys(options[0].properties ?? {}).filter((key) =>
    options.every((o) => typeof o.properties?.[key]?.const === 'string'),
  );
  if (candidates.length !== 1) {
    fail(
      `$defs/${name} is a oneOf without exactly one discriminating const field ` +
        `(found ${String(candidates.length)}). Use z.discriminatedUnion.`,
    );
  }
  return candidates[0];
}

function emitUnitEnum(name, schema) {
  const variants = schema.enum.map(
    (value) => `    #[serde(rename = "${value}")]\n    ${pascal(value)},`,
  );
  return `${doc(schema.description)}#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ${name} {
${variants.join('\n')}
}
`;
}

function rustType(prop, key) {
  if (typeof prop.$ref === 'string') {
    const match = /^#\/\$defs\/(.+)$/.exec(prop.$ref);
    if (match === null) fail(`unsupported $ref: ${prop.$ref}`);
    return match[1];
  }
  switch (prop.type) {
    case 'string':
      return 'String';
    case 'boolean':
      return 'bool';
    case 'number':
      return 'f64';
    case 'integer':
      // Unsigned where the schema says non-negative: a width or a version that can be -1 in Rust
      // but not in the schema is a difference the contract test cannot see.
      return typeof prop.minimum === 'number' && prop.minimum >= 0 ? 'u64' : 'i64';
    case 'array':
      return `Vec<${rustType(prop.items ?? {}, key)}>`;
    default:
      fail(`cannot generate a Rust type for property \`${key}\`: ${JSON.stringify(prop)}`);
      return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------------------------

/** Rust keywords that appear as plausible JSON field names. */
const KEYWORDS = new Set(['type', 'match', 'move', 'ref', 'box', 'self', 'crate', 'fn', 'mod']);

function snake(key) {
  const name = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.]/g, '_')
    .toLowerCase();
  return KEYWORDS.has(name) ? `r#${name}` : name;
}

function pascal(value) {
  return value
    .split(/[-._\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function doc(description, indent = '') {
  if (typeof description !== 'string' || description.length === 0) return '';
  return description
    .split('\n')
    .map((line) => `${indent}/// ${line}\n`)
    .join('');
}

await main();

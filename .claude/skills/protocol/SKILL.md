---
name: protocol
description: Rules for `packages/protocol` and `crates/riki-ipc` — the zod schemas, JSON Schema and Rust types for every message crossing a process or language boundary in Riki. Use when adding or changing a message between Electron main and renderer or between the app and the Rust vision sidecar, when running `pnpm codegen`, or when a contract test fails.
---

# Changing the protocol

`packages/protocol` defines every message that crosses a process or language boundary:
Electron main ↔ renderer, and Electron ↔ the Rust sidecar. It is deliberately small and
deliberately central — it is the one place two parallel agents *will* collide.

## Rules

- **zod is the source of truth.** JSON Schema is generated from it; Rust types in
  `crates/riki-ipc` are generated from that JSON Schema. Never hand-edit a generated file —
  that is the failure mode this whole arrangement exists to prevent.
- **Run `pnpm codegen` and commit the result.** CI fails if regenerating produces a diff.
- **Every message is versioned.** During development the sidecar and the app are routinely
  different builds. A version mismatch must produce a clear error, not a confusing parse
  failure three layers down.
- **Confidence, provenance and timestamp are non-optional on every CV-derived fact.** If a
  CV position can be constructed without a confidence score, it will eventually reach the
  agent as if it were certain, and Riki will tell a player something false with a confident
  voice. Make the type system refuse it.
- **Changing protocol is a coordination event.** Say so in the commit message, plainly and
  early in the message. Another agent may be mid-task against the old shape.

## Before you land

The contract test round-trips a shared fixture corpus: TS encodes → Rust decodes → Rust
re-encodes → TS decodes → deep-equal. Add your new message to `fixtures/protocol/` in the
same commit. A message with no fixture is a message the other language has never actually
parsed.

## Learnings

**2026-08-02 — `pnpm codegen` needs a TypeScript build in the middle, and it has to happen inside
the package.** Node cannot execute the schemas: under NodeNext the source writes `../version.js`
for `../version.ts`, and `--experimental-strip-types` does not remap that. So the generator
compiles `packages/protocol` to a scratch dir and imports the output. The scratch dir must live at
`packages/protocol/.codegen-tmp` — **not** at the repo root — because the compiled schemas still
`import 'zod'` and pnpm's strict `node_modules` only resolves it from under the package that
declares it. For the same reason `scripts/codegen.mjs` resolves `zod` through
`createRequire(packages/protocol/package.json)`.

**2026-08-02 — give every named schema `.meta({ id })` or the Rust output is a pile of anonymous
duplicates.** zod v4's `z.toJSONSchema` only lifts a subschema into `$defs` (and `$ref`s it) when
it carries an `id`; without one it inlines the same object at every use site, and the emitter has
no name to generate a struct from. One root schema (`SidecarProtocol`) referencing everything else
is what makes the `$defs` map the generator walks.

**2026-08-02 — generated files must be formatted by the same tools the gate runs.** `pnpm check`
runs `prettier --check .` and `cargo fmt --all -- --check` over the whole tree, so generated output
those two disagree with fails on a clean checkout. `codegen.mjs` therefore pipes its JSON through
Prettier and its Rust through `rustfmt`. Two traps in that: Prettier's `resolve()`d entry point is
CommonJS, so the ESM namespace wraps the real exports in `.default`; and `rustfmt` is skipped when
absent, which only works because the emitter is written to be rustfmt-stable. *Why:* if a
`codegen:check` failure appears on one machine and not another, that skip is the first place to
look.

**2026-08-02 — the Tier 3 round trip is pinned by the fixture, not by a live pipe.** The design
describes TS → Rust → TS. Implemented literally, it would vanish on any machine without a Rust
toolchain, because `scripts/cargo.mjs` skips cargo steps rather than failing. So each language
asserts `re-encode(fixture) == fixture` against the same corpus, which composes to the same
guarantee and keeps the TypeScript half running everywhere. One wrinkle: `serde_json::Value`
distinguishes `0` from `0.0` and JSON does not, so the Rust side normalises every number to `f64`
before comparing — otherwise you end up writing `0.0` into fixtures to satisfy one language's type
system.

**2026-08-02 — a field can only be non-optional in both languages if the *envelope* carries it.**
`CvFact` wraps every detection payload and holds `confidence`, `detector` and `capturedAtMonoMs`.
A new detector adds a `DetectionPayload` variant and inherits all three whether or not its author
thought about them. Repeating the three fields per variant would have been the obvious shape and
would have made forgetting one a code review question rather than a type error.

## See also

`REPO_SKELETON.md` §4 (protocol rules), §5.3 Tier 3 (contract tests);
`docs/dota2-state-capture-design.md` §4 (why provenance is structural).

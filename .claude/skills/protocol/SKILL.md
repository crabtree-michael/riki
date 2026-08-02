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

**2026-08-02 — a corpus keyed on message *type* reports full coverage while a payload union goes
unparsed.** The previous entry below fixed "which message is missing" by deriving the expected set
from the schema. That was not enough: `cv.detections` is one message type with a
`DetectionPayload` union inside it, so the corpus was green while a whole detector's wire shape had
never crossed into Rust. `contract.test.ts` now derives **both** — message types from each union's
options, and payload variants from `DetectionPayload.options` — and fails by name. Copy the pattern
to any union nested inside a message.

The concrete cost of getting this wrong showed up the same day, in the other direction: adding a
second `DetectionPayload` variant turned two irrefutable `let DetectionPayload::RegionDigest { .. } =`
bindings in `crates/riki-vision/src/session.rs` into compile errors. **`cargo build -p riki-vision`
passed** — both were behind `#[cfg(test)]` — so only `pnpm check` caught them. If you widen a
generated enum, run `cargo test`, not `cargo build`.

**2026-08-02 — the version check only ran in one direction, and the fake needed the other.**
`decodeSidecarEvent` existed; nothing in TypeScript could decode a *command*, because `crates/riki-ipc`
was the only reader of that half. `decodeSidecarCommand` is now its mirror over a shared
`decodeLine`. *Why:* if you write a fake for a protocol peer, make it decode with the real decoder.
`FakeVisionSidecar` runs the same version gate and the same schema the Rust side does, which is the
only reason its handshake test means anything — a fake that waved its own app's commands through
would agree with itself and nothing else.

**2026-08-02 — this package now holds two protocols, and only one of them generates anything.**
`schemas/sidecar.ts` crosses a *language* boundary and drives `pnpm codegen` → JSON Schema → Rust.
`schemas/voice.ts` (the voice window's preload bridge, ADR-0010) crosses a process boundary but not
a language one, so `MODULES` in `scripts/codegen.mjs` does not list it and `crates/riki-ipc` never
sees it. Adding a schema file does **not** wire it into codegen — the module list is explicit, which
is what makes that safe.

Consequences for the fixture rule. `fixtures/protocol/*.json` is the cross-language corpus and
`contract.test.ts` asserts every name matches `^(command|event)-`, so voice fixtures live in
`fixtures/protocol/voice/` — a subdirectory, which the `.endsWith('.json')` filter skips — with
their own test. Same rule, narrower guarantee: a same-build bridge cannot disagree across
languages, but it can absolutely drift from its own schema, and zod stripping unknown keys is what
turns that into a failing round trip instead of a silent misread.

**2026-08-02 — a corpus that covers eight of nine message types looks exactly as green as one that
covers all nine.** The sidecar corpus asserts `files.length >= 9` — a count, which cannot tell you
*which* message is missing and goes stale the moment someone adds a message and a fixture for a
different one. `voice-contract.test.ts` derives the expected set from the schema itself
(`union.options.map((o) => o.shape.type.value)`) and compares it to the types present in the corpus,
so a new message with no fixture fails by name. Worth copying into `contract.test.ts` next time
that file is touched.

**2026-08-02 — two properties of the voice bridge are asserted as *shape*, not as rules.** There is
no field on any message that could carry the API key (ADR-0015 — this is REPO_SKELETON §5.4's
"the key is absent from the preload bridge surface", as a property rather than a discipline), and
no field carries a monotonic timestamp, because main and a renderer do not share a
`performance.timeOrigin`. Both tests walk the union's shapes rather than reading the source, so
they fail on a field added later. *Why:* the second one is the trap — two `MonoMs` values from two
processes are both plausible-looking uptimes, and the difference between them is however long the
renderer took to start. Durations cross; timestamps do not.

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

# ADR-0018: Command argument schemas come from a local declaration, not zod, until protocol lands

**Status:** Accepted
**Date:** 2026-08-01

## Context

[`agent-command-execution-architecture.md`](../design/agent-command-execution-architecture.md) §4.2
sets one hard requirement for a command's arguments:

> **The schema and the validator must have one source.**

A hand-written JSON Schema that has drifted from its validator presents to the model exactly as
`pnpm codegen` exists to prevent for the sidecar: the model is told a shape, sends it, and is told
it is invalid.

That section proposes zod as the mechanism, because REPO_SKELETON.md §4 makes zod the repo's schema
tool. But `packages/protocol` is step 2 and is still empty, so nothing has yet chosen the zod major
version or the JSON-Schema emitter — and those choices belong to the package that has to make them
agree with generated **Rust**, which is the reason zod is the repo's tool at all. None of the eight
commands' arguments crosses a process or language boundary; they are flat strings, one optional
integer, and one enum.

## Decision

`packages/context/src/tools/codec.ts` declares a command's arguments once, as a record of field
specs, and derives both `decode()` and `.schema` from that record. `defineArgs()` is the only way to
build a codec, so the single-source property holds by construction rather than by review. Subject
fields (`hero`, `item`, `region`) are a field *kind*, which is what lets `resolve.ts` walk them
generically instead of eight handlers each doing their own alias lookup.

Extra properties are rejected, matching the `additionalProperties: false` the model is shown.

## Consequences

- No new runtime dependency, and Tier 3 does not pre-empt a decision `packages/protocol` owns.
- The derivation is about 200 lines and covers only what these commands need: strings with an
  optional length cap, bounded integers, booleans, string enums, and the three subject kinds. A
  command wanting nested objects or arrays has to extend it, and should consider that a signal to
  revisit this ADR rather than to add a case.
- Argument failures are phrased for a listener — "I need a hero for that — which one?" — because the
  model says them out loud. A generic schema library would have produced a validation message, and
  the failure text would have had to be written twice anyway.
- **The migration is a swap of one file, and it should happen.** When `packages/protocol` lands zod
  and a JSON-Schema emitter, `defineArgs` should be reimplemented on top of them and deleted here.
  `DeclaredCodec` is the seam: it exposes `schema`, `decode` and `subjects`, and nothing outside
  `codec.ts` knows how any of the three is produced.

## Alternatives rejected

- **Adopt zod now, in `packages/context`.** It would make Tier 3 the de facto owner of the version
  and emitter choice for a package that has to satisfy a Rust codegen path this component does not
  use. If protocol later picks differently, the migration is worse than the one above, not better.
- **Hand-write the JSON Schema next to a hand-written validator.** This is the failure the rule in
  §4.2 names.
- **Generate the validator from the JSON Schema at runtime** (ajv or similar). A dependency, a
  second failure-message vocabulary, and it inverts the direction: the schema is what the model is
  shown, and deriving both from a declaration keeps either side replaceable.

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

*(nothing yet — the first agent to learn something here adds the first entry)*

## See also

`REPO_SKELETON.md` §4 (protocol rules), §5.3 Tier 3 (contract tests);
`docs/dota2-state-capture-design.md` §4 (why provenance is structural).

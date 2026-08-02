# Voice bridge fixtures

The Tier 3 corpus for `packages/protocol/src/schemas/voice.ts` — every message that crosses the
voice window's preload bridge, once each.

**TypeScript only, and that is not an omission.** `fixtures/protocol/*.json` one level up is a
*cross-language* corpus: both TypeScript and Rust re-encode it and must produce the same bytes,
because the sidecar is a separate binary that may be a different build. These messages cross a
process boundary but not a language one, so there is no Rust half to disagree with and
`crates/riki-ipc` never sees them.

What the round trip still catches is the failure a same-build bridge actually has: a schema that
has drifted from the shape one side sends. zod strips unknown keys, so a fixture carrying a field
the schema no longer has comes back different and the test says so — which is the drift a fixture
is for, rather than something it absorbs.

`voice-contract.test.ts` is the assertion. Add a fixture in the same commit as a message; a message
with no fixture is one nothing has ever parsed from the outside.

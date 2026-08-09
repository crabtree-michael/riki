# Tool surface fixtures

The corpus for `packages/protocol/src/schemas/tools.ts` — the arguments the model may send and the
answers the five tools may give (ADR-0042, ADR-0043).

`arguments-<tool>*.json` is a call; `result-<tool>*.json` is an answer. `tools-contract.test.ts`
derives the expected set from `ToolName.options`, so a tool with no fixture fails by name rather
than being counted.

**Neither Rust nor another build reads these.** The corpus one level up is cross-language and the
`voice/` one crosses a process boundary; this one crosses to a language model. What the round trip
catches is the same drift in both of the others — zod strips unknown keys, so a fixture carrying a
field the schema no longer has comes back different and the test says so.

## What the corpus is for beyond the round trip

Every `result-*-unknown.json` is a complete answer in which **nothing was observed**. They exist
because that is the answer the design is most worried about getting wrong: a tool that cannot
distinguish "zero" from "never seen" states a guess as a fact, out loud. They are also the target
shape for `packages/world-model`'s tools — an implementation that can produce these can degrade
honestly.

The test mutates the known fixtures leaf by leaf, so together they assert two properties of every
fact-shaped field in all five tools: it may be `{ "unknown": … }`, and it may **not** be a bare
value.

## Two conventions worth knowing before writing one

- **`respawn_in_seconds` is `0` for a living hero, not `unknown`.** GSI reports zero, and zero is
  true — you are no seconds from being alive. `unknown` is for what nobody observed, and stretching
  it to cover "does not apply right now" is how it stops meaning anything.
- **A top-level `{ "unknown": … }` is a whole tool declining to answer** — no match in progress, no
  hero by that name, a moment before the recording starts. Per-field unknowns are the ordinary
  case; this one is not an error path either.

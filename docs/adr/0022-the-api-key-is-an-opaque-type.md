# ADR-0022: The API key is an opaque type, not a string

**Status:** Accepted
**Date:** 2026-08-01

## Context

REPO_SKELETON.md §7.1 confines `RIKI_OPENAI_API_KEY` to `packages/config` in the main process,
injects it into `packages/realtime`, and keeps it off the preload bridge.
[ADR-0015](0015-ephemeral-client-secret-minted-in-main.md) adds the second half: the renderer gets
an ephemeral client secret and never the key. A lint boundary (§6.2) makes `process.env` unreadable
outside `packages/config`, and §5.4 asks for a test proving `packages/realtime` never reads it.

All of that guards the **deliberate** leak — someone reaching for the environment in the wrong
place. None of it guards the accidental one, and the accidental one is the realistic one:

```ts
telemetry.debug('realtime deps', deps);     // deps.apiKey is a string
throw new Error(`mint failed for ${key}`);  // interpolated into a log
console.log(config);                        // main process, util.inspect
```

No lint rule sees any of these, `packages/telemetry`'s redaction rules only fire on fields it has
been told about, and the failure is invisible until a key appears in a support bundle. The
scaffolded `ClientSecretBrokerDeps.apiKey` was a `string`, so all three compile.

## Decision

`ClientSecretBrokerDeps.apiKey` is an **`ApiKey`**, a class in
`packages/realtime/src/credentials.ts` that renders as `[redacted]` through `toString`, `toJSON`
and `Symbol.for('nodejs.util.inspect.custom')`. The real value is reachable only through
`reveal()`, which is named to be greppable and to look wrong in a log statement. The constructor
rejects an empty value, naming `RIKI_OPENAI_API_KEY`.

`packages/config` constructs the single instance; nothing else does.

## Consequences

- The three accidents above now produce `[redacted]` instead of a key. That is the entire point,
  and it holds without anyone remembering.
- **All three redaction hooks are load-bearing and one is easy to miss.** `toString` does not
  cover `console.log`/`util.inspect` in the main process, which is the most likely place a config
  object gets dumped. The test asserts each hook separately for that reason.
- It changes a contract another agent scaffolded (`credentials.ts`, commit `c352a25`) from
  `string` to `ApiKey`. `packages/config` is still a stub, so there is no caller to migrate today
  — but whoever implements §7.1's resolution must construct an `ApiKey` rather than return a
  string, and this ADR is where they find out why.
- `reveal()` is a hole by construction. It has exactly one call site — the `Authorization` header
  in `ClientSecretBroker.mint` — and a second one should be treated as a design question rather
  than a convenience.
- It does not help anything that already has the raw string: an `ApiKey` built from a value that
  was logged on the way in is closing the door afterwards. The value goes from `process.env` into
  the constructor in one expression.

## Alternatives rejected

- **Leave it a `string` and rely on `packages/telemetry`'s redaction.** That redacts fields it
  knows about, in the sink. It cannot help a key already interpolated into a message string, which
  is the common case.
- **A branded string type (`string & { __brand: 'ApiKey' }`).** Type-level only; it stringifies
  and serialises exactly like the string it is, so it prevents none of the three accidents.
- **A lint rule banning the identifier `apiKey` in template literals and `JSON.stringify`.** Wide
  net, easy to work around by renaming a variable, and it would fire on this very file.
- **Wrap the whole deps object.** Larger change, and the key is the only field in it worth
  protecting.

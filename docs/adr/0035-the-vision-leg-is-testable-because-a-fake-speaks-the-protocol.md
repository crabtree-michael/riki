# ADR-0035: The vision leg is testable because a fake speaks the protocol, not because the app has a second wiring

**Status:** Accepted
**Date:** 2026-08-02

## Context

`RIKI_FAKE_VISION` has been documented since the skeleton was written — a row in
[REPO_SKELETON.md](../../REPO_SKELETON.md) §5.2's table of four shared fakes, a variable in
`.env.example`, a key in `packages/config` with defaults, a schema entry and a passing test. What it
did not have was an implementation, or a single reader of `config.vision.fake` anywhere in
`apps/desktop`.

The consequence was larger than a missing fake. Three facts together meant **the vision → world
model → coaching edge of the loop had never executed anywhere, on any machine, in either
language**:

1. `crates/riki-vision` can only capture on macOS, and that backend has never been run
   ([ADR-0033](0033-screencapturekit-is-the-shipping-backend.md)).
2. Its one portable backend, `--backend replay`, has no digit or icon atlas, so every fact it
   emits is a `region.digest` — a hash of a crop, which is a fact about the capture pipeline and
   not about the match.
3. `enemies[].position` has exactly one source and it is computer vision. GSI cannot see an enemy,
   and [state-capture-architecture.md](../design/state-capture-architecture.md) §5.3 allows only
   what the minimap renders. So `enemy_missing` — the detector
   [dota2-state-capture-design.md](../dota2-state-capture-design.md) §6.2 says matters most — could
   not fire in any test that exists.

Building the fake found what that had been hiding. `apps/desktop/src/main/sidecar/protocol-codec.ts`
emitted the wire shape verbatim — `{ regionId, detector, confidence, observedAt, payload: { kind } }`
— while `packages/world-model`'s `readCvDetections` reads a **flat** record and switches on a
top-level `kind` it has never heard of. Applied to a store, one sidecar batch produced
`{ accepted: 0, rejected: [{ field: 'cv.region-digest/v1', why: 'unparsed' }] }`. Every CV
observation the app has ever produced was counted and discarded. Nothing failed, because nothing
ran.

## Decision

### The fake plugs in at `ChildProcessPort`, and there is no second wiring

`FakeVisionSidecar` lives in `packages/protocol/src/testing/` and implements the app's
`ChildProcessPort` structurally — spawn, stdout/stderr/exit listeners, `write`, `kill`. That is the
narrowest seam in the app and the one place `node:child_process` is reached for, so everything above
it is production code: `createSidecarSource` supervises it, `createProtocolCodec` does the handshake
and the two-clock arithmetic, `SourceSupervisor` restarts it with real backoff when it dies, and
fusion applies the real confidence and precedence gates.

A fake implementing `SidecarSource` would have been simpler and would have tested none of that.

It follows that `apps/desktop/src/main/shell/index.ts` **does not branch on `vision.fake` beyond
not requiring a binary path** — which port arrived is `main/index.ts`'s decision and the shell
cannot tell. A shell with a fake-specific path would be a shell whose real path is what goes
untested.

The fake also runs the handshake gate for real, mirroring `crates/riki-ipc/src/handshake.rs`: a
command before `hello` is answered with `handshake_required` and *not acted on*, a second `hello` is
answered again, and a version it does not speak is fatal. Commands are decoded with
`decodeSidecarCommand`, the same version check and schema the Rust side runs. A fake that waved its
own app's commands through would only ever agree with itself.

### `minimap.hero` joins `DetectionPayload` — a protocol change, one sighting per fact

For the loop to close, some message has to be able to carry a hero's position. `DetectionPayload`
gains a `minimap.hero` variant carrying `{ hero, side, at }`, where `at` is a `NormalizedPoint` in
the crop's own 0..1 coordinates.

**One sighting per `CvFact`, not a list per pass.** Confidence, provenance and the capture timestamp
live on the `CvFact` envelope, so a `minimap.heroes: [...]` payload would have given one confidence
to a whole pass — and the weakest blob in it would inherit the strongest one's score. That is
exactly the confident-hallucination failure the envelope exists to prevent.

`crates/riki-vision` cannot produce this variant and is not expected to; it has no atlas. The type
exists so the fake, and eventually a real minimap detector, have something to say.

### The codec translates, and the digest is not a fact

`protocol-codec.ts` now maps protocol facts into the world model's vocabulary rather than passing
them through. `region.digest` maps to *nothing* and moves to a separate `digests` key on the
observation, which `readCvDetections` ignores by construction. It stays on the observation because
it is the only evidence capture is running while nothing on screen has moved.

The switch in `toDetection` deliberately covers `region.digest` too, even though its caller has
already handled it: that redundancy makes adding a variant a non-exhaustive-switch error rather
than a detection that silently becomes `unparsed` — which is the failure being fixed.

### Minimap coordinates become Dota world units, at a scale that is admittedly approximate

`MAP_WORLD_EXTENT_UNITS = 16576` (about −8288…8288 per axis, community-documented, unverified here)
and the crop's downward `y` is flipped to the world's upward one.

Converting is not optional, and it is worth being explicit about why an imprecise conversion beats
none. `self.position` arrives from GSI in real world units, and `nearbyEnemies` compares the two
against a 2000-unit radius. Emitting 0..1 into that field would put every enemy within one unit of
the origin and therefore inside any radius — `nearbyEnemies` would return the whole enemy team
forever, which is "silently into wrongness" rather than a rounding error. The scale error affects
only that comparison; `enemy_missing` asks whether a position exists and how old it is, never where,
so the vision → coaching edge is correct at any scale.

## Consequences

- **This is a coordination event.** `packages/protocol`'s zod changed, `pnpm codegen` regenerated
  `sidecar.schema.json` and `crates/riki-ipc/src/generated/`, and two irrefutable `let
  DetectionPayload::RegionDigest { .. } =` bindings in `crates/riki-vision/src/session.rs` became
  `let ... else`. An agent mid-task against the old single-variant enum will hit the same two.
- **The corpus now fails by name.** `contract.test.ts` derives the expected message types *and*
  `DetectionPayload` variants from the schema, so a variant with no fixture fails saying which. The
  old `files.length >= 9` reported full coverage while a whole detector's wire shape had never been
  parsed by Rust.
- **`enemy_missing` fires, and is spoken.** `apps/desktop/test/vision-coaching.test.ts` drives
  `FakeGsiSource` for the match and `FakeVisionSidecar` for the map, and asserts a coaching turn
  whose `eventId` is `enemy_missing` — with a negative control in the same file where the crank is
  never turned and the count is zero.
- **`RIKI_FAKE_VISION=1` needs `RIKI_VISION=on` as well.** They stay orthogonal: a development flag
  that switches a subsystem on by itself is the kind of surprise `packages/config`'s layering is
  built to avoid. `.env.example` says so on the line.
- **What is still unproven.** The world-unit scale and the minimap crop rectangle are both guesses
  that only a Mac running Dota can settle, and until then `nearbyEnemies` is calibrated to a
  plausible number rather than a measured one. The hero sightings in `fixtures/vision/` are the
  shape a detector is *specified* to produce, not one observed to produce; the fixture header lists
  what a real recording would settle. And nothing here makes `crates/riki-vision` able to recognise
  a hero — the atlas work is untouched.
- **The map-region table is still absent.** `self.area` and `enemies.*.area`, the named-lane strings
  `packages/context` renders, need a position → region lookup that does not exist. That gap is
  unchanged by this ADR and is not on the path to `enemy_missing`.

## Alternatives considered

**A fake at the `SidecarSource` seam.** Half the code and none of the value: the supervisor, the
codec, the handshake, the line buffering and the restart policy are precisely the parts that have
never been exercised against a peer that can refuse or die.

**Leaving `region.digest` in `detections` and teaching `readCvDetections` to ignore it.** That puts
knowledge of the wire format into `packages/world-model`, which §4.3 keeps free of it, and would
have made every quiet pass a counted rejection rather than a no-op.

**Shipping the fake without the protocol variant.** The honest outcome would have been a fake that
could only emit region digests — which is to say, a fake that reproduces the exact situation this
ADR exists to end. The vision leg would still never have run.

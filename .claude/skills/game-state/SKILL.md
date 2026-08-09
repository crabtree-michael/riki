---
name: game-state
description: Observing a live Dota 2 match and fusing it into the world model — `packages/gsi`, `packages/log-tail`, `packages/world-model`. Covers GSI's unreliable update rate and local-player-only limitation, console log tailing, source precedence, staleness, confidence and provenance. Use when handling GSI POSTs, parsing the console log, or changing how facts are merged, aged or trusted.
---

# Game state and the world model

The single most important architectural fact: **the world model is a normal in-memory data
structure, not a conversation transcript.** State arrives at 5–10 Hz; the agent speaks maybe
once a minute. Coupling those rates would be ruinous for both cost and latency.

## GSI (`packages/gsi`)

Valve's sanctioned integration. The client POSTs JSON to a local endpoint with a per-install
auth token.

- **The update rate is unreliable.** `throttle`/`buffer` at `0.1`/`0.1` targets ~10 Hz, but
  observed delivery is **2–8 Hz and irregular**, varying with client load. **Never derive
  timing from update count.** Always use `map.clock_time` plus a local monotonic clock.
- **`heartbeat` guarantees a POST every 30 s** even when nothing changes. That is the
  liveness check — a missed heartbeat means degrade to CV-only and tell the user.
- **In a live game GSI exposes only the local player.** Full ten-player data, `minimap`,
  `roshan` and `couriers` are gated to spectators. Valve did that deliberately, and it is
  the entire justification for the vision layer. Do not look for a way around it.
- **macOS is the primary target; Linux is only the dev platform.** Dota 2 ships a native
  macOS client, so GSI there is on Valve's supported path — but Linux/Proton GSI has a
  history of bugs, which means the *dev box* is the unreliable one. Treat a GSI oddity seen
  locally as a Proton artefact until proven otherwise, and develop against the fixture
  corpus rather than a local client.

## Console log (`packages/log-tail`)

Cheap and high-value: chat, kill feed and pings without OCR. Handle log rotation — the file
you opened is not the file that is being written to ten minutes later.

## The world model (`packages/world-model`)

- **GSI beats CV. CV never overwrites fresh GSI.** Precedence is not a heuristic; encode it.
- **Everything ages.** Staleness decay is part of the model, not a rendering concern. A fact
  with no age is a fact that will be presented as current.
- **Provenance and confidence travel with every fact**, structurally, all the way to the
  agent. Facts below the confidence threshold are dropped, not softened.
- **The model must not import `packages/realtime`.** It must not know it is feeding an LLM;
  a lint boundary enforces this. That decoupling is what lets state arrive at 8 Hz while the
  agent speaks once a minute.
- Keep a ring history. Derived state (gold-to-item, buyback affordability, Roshan window) is
  computed from the model, not stored alongside it.
- **One file in the package does I/O**, `record/file-sink.ts`, and that is deliberate (ADR-0044).
  Everything else, including the recorder, is pure over an injected `RecordSink`. If you find
  yourself adding a second `node:fs` import here, the seam is in the wrong place.

## The match recording (`packages/world-model/src/record/`)

A match is appended to `<dataDir>/matches/<matchId>.jsonl` as it plays — every observation with its
timestamps, plus a serialised `WorldState` keyframe every 30 s. It is the agent's memory
(conversational-architecture.md §6) and it is what `world_at` seeks into.

**The recording is a `fixtures/gsi/*.jsonl` fixture.** Every line carries `atMs` and `body`,
including the header and the keyframes, which carry `body: {}`. That single field is the whole
compatibility rule — see the learning below for what happens without it, because the failure is
silent.

Three rules that are easy to break by accident:

- **Do not buffer.** The recorder writes through to `writeSync` so a killed process costs the
  half-written last line and nothing else. `parseRecordLines` reports a truncated tail and
  distinguishes it from corruption in the middle; `parseGsiFixture` does neither and will throw on
  a crash-truncated file, so drop the partial line before replaying one.
- **A keyframe is `flattenFacts`, not the object graph.** Adding a field to `WorldState` needs no
  change to the encoder. Writing a bespoke encoder means the next field is silently not recorded.
- **Chat text never reaches the file.** The event is recorded with `text` and `speaker` removed and
  `redacted: true` on the line (dota2 §7). `player.steamid` is *not* hashed yet — T10 owns that.

## Fairness

Riki may only reason about what the player can already see. If a fusion rule would surface
something the player has no way to know, it is wrong regardless of how the data arrived.

## Two clocks, and they are not interchangeable

Wall time (local monotonic) and match time (`map.clock_time`) answer different questions, and the
bug you will write is using one where the other belongs.

**Tactical facts age in match time; pipeline facts age in wall time.** During a pause nothing on the
map moves, so an enemy position from 10 s ago is still exactly true and must not expire — but a
client that has not POSTed for 40 s of paused game is still gone. One `basis: 'wall' | 'game'` field
on the age policy makes both correct through a pause without special-casing either.

## Learnings

**2026-08-01 — the class-level contract now exists, and it is a separate document.**
`docs/design/dota2-state-capture-design.md` decides *what* is observed; **`docs/design/state-capture-architecture.md`**
decides the module and class shape — the `Fact<T>` envelope, `ObservationSource`, the pure
`FusionReducer`, the precedence matrix (§5.3, which is per *field class*, not global), and the read
interface `context`/`events` get. Read it before writing anything in `gsi`, `log-tail` or
`world-model`; the §5.3 table in particular answers "may CV write this field?" and the answer is not
always the same for two fields in the same object. *Why:* the older doc's §4 is explicitly
illustrative, and two agents reading it independently will not invent the same class boundaries.

**2026-08-01 — "GSI beats CV" needs a freshness number to be implementable.** The rule as written in
this skill is ambiguous about a *silent* GSI: if the client stopped POSTing 20 s ago, may a CV fact
land on a GSI-owned field? The architecture answers it with a shadow window (2 s, tunable) rather
than leaving it to each call site. *Why:* both readings are defensible, they produce opposite
behaviour during a GSI dropout, and that dropout is exactly when Riki is most likely to say something
wrong.

**2026-08-01 — the three packages are implemented; read §13 of the architecture before §3–§7.**
`state-capture-architecture.md` gained a §13 recording every place the implementation disagreed with
the contract, and the sections above it were *not* rewritten in full. So §3.5's `WorldState` and
§5.1–§5.3's signatures are the intent, and §13 is what the code does. *Why:* four of the six
differences are shape changes you would otherwise discover from a type error — `self.abilities` is
`Fact<readonly AbilityState[]>`, not an array of facts, and `enemies[].itemsSeen` is a `Map`.

**2026-08-01 — "never writes" has to mean rank 0, not lowest priority.** The obvious reading of the
§5.3 matrix — rank the sources and let the shadow window sort out the rest — quietly lets a CV
reading land on `self.health` after two seconds of GSI silence. It must never land there at all:
that is the *whole* input to the drift monitor (§5.6), and admitting it as a fact both corrupts the
model and destroys the calibration signal. Implement the "Never writes" column as an
unconditional refusal *before* the shadow window is consulted, and test it at a stale field with a
long-quiet authoritative source. *Why:* every other rule in the matrix is a comparison, so this one
reads like a comparison too, and the failure is silent.

**2026-08-01 — a CV batch's timestamp is not its detections' timestamps.** The batch is later than
every region in it by however long the CV worker took, and the regions in one batch were sampled at
different moments anyway. Age each detection from its own `observedAt` and treat the batch time as a
ceiling. *Why:* using the batch time makes every position look fresher than it is, in exactly the
direction that gets someone killed — and it is invisible in testing unless a test deliberately puts
the two timestamps apart.

**2026-08-01 — fusion stamps a non-GSI observation with the clock the model currently holds.** So a
CV batch arriving before the first GSI POST is stamped clockless and ages in wall time. That is
correct — there was no match clock to age it against — but it means the *order* of the first two
observations changes how the first CV fact ages, and a test that feeds CV first will see `expired`
where it expected `fresh`. *Why:* cost twenty minutes here; the fix is to feed GSI first in any test
that cares about ageing, which is also what happens in production.

**2026-08-01 — the console-log matchers are unverified guesses and are marked as such.** Nobody has
run Dota with `-condebug` (dota2 §2.3 still lists it as open, and the dev box has no client), so
`packages/log-tail/src/matchers/*` were written against community reports and
`fixtures/console-log/` is synthetic. The tailer underneath them — rotation, truncation, partial
lines, start-mid-file — is real and tested against temp files. *Why:* if you have a capture, replace
the fixtures and run the matcher tests; every failure is a matcher to fix, and if kills turn out not
to reach `console.log` at all, delete `killfeed.ts` rather than fighting it — `enemies.*.alive`
already falls back to top-bar CV through the `enemy_liveness` class.

**2026-08-01 — a real GSI capture contains the per-install token, and `fixtures/gsi/` must not.**
The `auth` block is inside the POST body, not a header, so a naive recorder writes the secret
straight into a committed fixture. `packages/gsi`'s parser drops `auth` before building a payload
(there is a test asserting a token cannot reach an `Observation`), but `tools/gsi-record` is the
place that has to strip it on the way in. *Why:* gitleaks will not recognise a Riki install token,
so nothing else catches this.

**2026-08-01 — `FakeGsiSource` does not implement `onLifecycle`, and its header says it does.**
Its comment reads *"satisfies the same interface as `GsiServer`, so a consumer wired to it is
wired"*. It does not: `createGsiServer` returns `GsiServerWithExtras`, which has `onLifecycle`,
`estimateClock` and `stats`, and the fake has the last two only. A consumer wired to the fake
therefore **never sees `match_started`** — so no world-model reset, no preamble, and in the shell
no coaching root at all. Nothing fails; the pipeline just quietly never begins.

The workaround, until the fake grows the method, is what `createGsiServer` does internally — feed
that package's own `createMatchSessionTracker()` from the observation stream:

```ts
const tracker = createMatchSessionTracker();
source.subscribe((o) => {
  const events = tracker.observe(o.payload, { observedAt: clock.now() });
  if (events.length > 0) listener(events);
});
```

There is a worked copy in `apps/desktop/src/main/shell/shell.test.ts`. *Why:* this is the seam
`tools/gsi-replay` and the tuning harness (coaching-trigger §16 step 3) both sit on, and the
failure is silent in the worst way — every stage looks healthy and nothing ever starts.

**2026-08-01 — a live GSI listener is testable from a shell prompt, and it is worth doing once.**
With the app running, take the token from the app's data directory
(`~/.config/Riki/gsi-token`, `~/Library/Application Support/Riki/gsi-token` on macOS), splice it
into a fixture line as `auth.token`, and POST it:

```shell
curl -X POST -H 'Content-Type: application/json' -d "$BODY" http://127.0.0.1:53101/
```

`200` accepted · `403` bad or missing token · `405` not a POST · connection refused means the
listener never bound. Replaying all of `fixtures/gsi/laning-phase.jsonl` this way is the cheapest
end-to-end proof that exists, and it needs neither Dota nor a test harness.

**Two traps in that replay, both of which return `200` while proving nothing.** The fixture lines
are `{"atMs":…,"body":{…}}` envelopes — Dota POSTs the **body**, with `auth` inside it, so posting
the whole line authenticates fine and parses to nothing at all. And the replay must run at **1x**:
see the next entry for why an accelerated one is not a faster version of the same test.

**2026-08-02 — a GSI replay cannot be accelerated, and `fixtures/gsi/laning-phase.jsonl` was
inconsistent for the life of the file.** `packages/gsi`'s session tracker calls a
`clock_discontinuity` when `map.clock_time` and elapsed wall time disagree by more than
`DISCONTINUITY_THRESHOLD_SECONDS` (5), and `apps/desktop`'s state subsystem answers one by
**resetting the world model**. So replaying at 10x *is* a discontinuity, by construction — there is
no fast version of this test, and `FakeGsiSource`'s `speed` option has the same property.

The fixture had the same defect baked in: its `atMs` values were authored independently of its
`clock_time` values, so game time ran ~25x wall time and a full replay wiped the world on nine or
ten of its twenty-two frames. Nothing caught it. `shell.test.ts` — the Tier 4 test for the whole
loop — advanced a flat 250 ms per line regardless of the recording, which reproduced the same
disagreement, and it asserted only that *a* coaching turn came out. One did, through ten world
resets. The visible symptom, once the telemetry was recorded, was suppression reasons that made no
sense: `not_in_match` and `global_cooldown` mid-match, where a healthy run reports `below_threshold`
and `high_intensity`.

Both are fixed, and `packages/gsi/src/gsi.test.ts` now asserts the whole corpus replays with zero
discontinuities. *Why it is worth knowing anyway:* **if you add or edit a `fixtures/gsi/*.jsonl`,
`atMs` and `map.clock_time` have to advance together** — the paused rows are the only exemption,
because the tracker skips the check while `paused` is true. And a replay harness must advance its
clock by the recorded gap, never by a constant; a constant is what hid this.

**2026-08-09 — `createGsiPayloadParser` accepts every object, so "the parse succeeded" is not an
assertion.** Writing the match recorder, the load-bearing decision was that a keyframe line carries
`body: {}`. Omitting `body` looks harmless: `parseGsiFixture` falls back to `parsed.body ?? parsed`,
so the *whole keyframe* becomes the POST body, and `parse()` files everything it does not recognise
under `unknown` and returns `{ ok: true }` (parse.ts is explicit that "almost nothing is rejected",
because Valve adds components without announcing them). A replayed recording therefore delivers a
`gsi.payload` observation whose `unknown` holds the entire serialised world, silently.

The first two tests written for this passed with `body` deliberately removed — one asserted
`result.ok`, the other counted `map.clock_time` values and the bogus payloads had none. What catches
it is asserting on `Object.keys(result.value.unknown)`: no record-envelope key (`atMs`, `kind`,
`state`, `seq`, …) may appear there. *Why:* against a parser that fails open, every "did it parse"
test is a test that passes. Assert on what the parse *produced*, and prove it by breaking the
implementation and watching the test go red — both of these only became real tests that way.

**2026-08-09 — `WorldModelStore` exposes no `WorldState`; `snapshot(now).state` is the way out.**
`WorldModelReader` is `snapshot` / `onVersion` / `history`, and `WorldSnapshot.state` is the full
model. Taking a snapshot per observation is cheap enough to do on the 8 Hz path — `derived.resolve`
builds a *view* and computes nothing until a rule id is asked for — so the recorder reads the store
that way rather than the store growing an accessor. *Why:* the obvious move is to add a getter to
`store.ts`, and the second writer into that file is how a single-writer invariant stops being one.

## See also

`docs/design/dota2-state-capture-design.md` §2 (sources), §4 (the model), §8.2 (fairness),
§9 (failure modes); `docs/design/state-capture-architecture.md` (classes, method signatures, module
boundaries — and **§13 for where the code differs**);
`docs/adr/0014-observation-reducer-seam.md`; `REPO_SKELETON.md` §5.3 (tiers),
§6.2 (module boundaries).

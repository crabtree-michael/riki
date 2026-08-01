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

## See also

`docs/design/dota2-state-capture-design.md` §2 (sources), §4 (the model), §8.2 (fairness),
§9 (failure modes); `docs/design/state-capture-architecture.md` (classes, method signatures, module
boundaries — and **§13 for where the code differs**);
`docs/adr/0014-observation-reducer-seam.md`; `REPO_SKELETON.md` §5.3 (tiers),
§6.2 (module boundaries).

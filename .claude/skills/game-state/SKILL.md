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
- **Linux/Proton GSI has a history of bugs.** Validate on the target platform early rather
  than assuming parity with Windows.

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

## See also

`docs/design/dota2-state-capture-design.md` §2 (sources), §4 (the model), §8.2 (fairness),
§9 (failure modes); `docs/design/state-capture-architecture.md` (classes, method signatures, module
boundaries); `docs/adr/0008-observation-reducer-seam.md`; `REPO_SKELETON.md` §5.3 (tiers),
§6.2 (module boundaries).

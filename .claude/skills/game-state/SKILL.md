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

## Learnings

*(nothing yet — the first agent to learn something here adds the first entry)*

## See also

`docs/dota2-state-capture-design.md` §2 (sources), §4 (the model), §8.2 (fairness),
§9 (failure modes); `REPO_SKELETON.md` §5.3 (tiers), §6.2 (module boundaries).

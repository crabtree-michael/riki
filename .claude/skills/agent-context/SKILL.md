---
name: agent-context
description: What the LLM sees and when Riki speaks — `packages/context` (session preamble, rolling snapshot, agent tools) and `packages/events` (salience scoring, trigger policy, interrupt gates). Use when changing the snapshot format or its token budget, adding an agent tool, or changing the rules that decide whether Riki says anything at all.
---

# Feeding the agent, and deciding when to speak

The agent never sees the raw stream. It sees three tiers, and the third is pull, not push.

1. **Session preamble** — written once, cached. Hero pool, patch, player history.
2. **Rolling snapshot** — ~250–400 tokens, refreshed per turn. This is the hot path.
3. **Tools** — `get_enemy_detail` and friends. The agent asks; nothing is pushed.

## The snapshot format is an interface

It is the interface to the LLM, so treat a format change like an API change: it goes through
`fixtures/golden/`, and the diff is the review. Rules that hold in the renderer:

- **Never render a stale CV fact as a bare fact.** A 30-second-old position must carry its
  age and confidence, visibly, in the rendered text. Presenting a guess as certainty is the
  worst outcome the product has.
- **Below-threshold facts are dropped, not hedged.** Hedging spends tokens to say nothing.
- **Budget is enforced by priority truncation**, not by hoping. Test the truncation order —
  what survives when the budget is tight is a design decision, not an accident.

## Trigger policy — invisible until needed

The default is silence. `packages/events` scores salience and then has to clear gates
before anything reaches the agent:

- **Not during a teamfight.** Riki talking over a fight is worse than Riki saying nothing.
- **Not while the player is speaking.**
- **Cooldown and novelty gates.** Saying a true thing for the third time is noise.
- **"Only when I ask" mode must actually be silent** — it is a supported configuration, and
  it defaults off but is asserted by test.

When you change scoring, add the case to the suppression tests. The failure mode here is not
a crash; it is a product that people turn off.

## Latency

Model → snapshot is budgeted at under 5 ms. The snapshot is rendered per turn, so anything
expensive belongs in the world model's derived state, computed once, not in the renderer.

## Learnings

*(nothing yet — the first agent to learn something here adds the first entry)*

## See also

`docs/dota2-state-capture-design.md` §6 (all three tiers), §6.4 (trigger policy),
§6.5 (latency budget); `REPO_SKELETON.md` §5.3 Tier 2 (golden tests), §11 item 5 (where the
persona lives — open).

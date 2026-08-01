# ADR-0003: Read-only observation only

**Status:** Accepted. Not open for re-litigation without a human decision.
**Date:** 2026-08-01

## Context

Riki needs to know what is happening in a live match. Several techniques would give richer data
faster: reading game memory, injecting into the client, drawing an in-game overlay, synthesising
input. Every one of them is what anti-cheat systems exist to detect, and a banned user is an
unrecoverable outcome for the product.

## Decision

Riki observes only through channels Valve provides or that any screen recorder uses: Game State
Integration, the client's `console.log`, and screen capture of what is already on the player's
display. **No memory reads, no injection, no in-game overlay, no input synthesis.**

The overlay is an ordinary always-on-top desktop window, not something drawn inside the game.

## Consequences

- GSI in a live game exposes only the local player's data; full ten-player state, minimap,
  Roshan, and couriers are gated to spectators. Valve gated them deliberately, for exactly the
  reason we respect the gate — and that gap is the entire justification for the vision layer.
- The vision layer must infer from pixels what memory reading would hand over directly. That is
  slower, noisier, and needs confidence and provenance on every fact it produces.
- Riki can only ever tell the player what the player could already see.

## Alternatives rejected

- **Memory reading / injection** — a ban risk we will not take on a user's behalf, whatever the
  data quality gain.

See [dota2-state-capture-design.md](../design/dota2-state-capture-design.md) §1 and §8.

# ADR-0005: A monorepo with a central protocol package

**Status:** Accepted
**Date:** 2026-08-01

## Context

Riki is three subsystems in two languages — an Electron app, a set of TypeScript libraries, and
a Rust capture/CV sidecar — and multiple agents work on it in parallel, committing directly to
`main` without a review queue. The layout has to make parallel work cheap and collisions rare.

## Decision

One repository. One package or crate per named concern in the architecture: `packages/gsi`,
`packages/world-model`, `packages/context`, `packages/events`, `crates/riki-capture`, and so on.
Business logic lives in `packages/`, not in `apps/desktop`, which stays thin — wiring, windows,
and platform calls.

Everything crossing a process or language boundary is defined once in `packages/protocol`: zod
is the source of truth, JSON Schema is generated from it, and the Rust types in
`crates/riki-ipc` are generated from that. `pnpm codegen` regenerates; CI fails if the result is
dirty.

## Consequences

- Two agents' tasks usually touch disjoint directories, so parallel commits to `main` mostly do
  not conflict.
- Pure logic — fusion, snapshot rendering, salience scoring — is testable in milliseconds with
  no window, no game, and no GPU.
- `packages/protocol` is the one place agents _will_ collide, so changing it is a coordination
  event that must be called out in the commit message.
- Generated Rust must never be hand-edited; the codegen-clean CI job is what catches it.

## Alternatives rejected

- **A single flat `src/`** — guarantees merge conflicts and hides the seams the design docs are
  explicit about.
- **Separate repos per component** — the protocol contract has to be versioned in lockstep;
  polyrepo makes the most fragile boundary the hardest to change.
- **CV in-process with the app** — the CV worker has to be able to crash without taking the
  agent down.

See [REPO_SKELETON.md](../../REPO_SKELETON.md) §2 and §4.

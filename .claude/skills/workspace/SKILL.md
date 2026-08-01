---
name: workspace
description: How work is organised in the Riki repo — which package owns a change, what `pnpm check` must say before you commit, how to commit to `main` while other agents work in parallel, and how to update these skills when you learn something. Use at the start and end of any task in this repository.
---

# Working in the Riki repo

Riki is a voice coach for Dota 2 that is *invisible until needed*. That product promise is
the source of most of the constraints you will hit, in every area.

## Read these first, in this order

| Question | File |
|---|---|
| Who dispatched this task, what "done" means | `AGENTS.md` |
| Where my code goes, testing, linting, CI | `REPO_SKELETON.md` |
| Is this already decided? | `docs/adr/` |
| How the subsystem is meant to work | `docs/` |

## Which package owns my change

`REPO_SKELETON.md` §2.2 is the ownership map — task shape on the left, directory on the
right. Use it rather than guessing; the layout exists specifically so two agents working in
parallel touch disjoint directories.

Two rules follow from that:

- **Stay in your directory.** If the task seems to need a change in someone else's package,
  that usually means the seam is in the wrong place. Say so in your report instead of
  reaching across.
- **`packages/protocol` is the exception, and it is a coordination event.** See the
  `protocol` skill before touching it.

## Before you commit

- `pnpm check` is green. It is lint + typecheck + test + codegen-clean, and it is exactly
  what CI runs, so a green local check means no surprise after pushing.
- New behaviour has a test at the lowest tier that can catch it (`testing` skill).
- A decision you made is an ADR in `docs/adr/`, not a code comment.
- Something you learned is in the area's skill (below).

**Definition of done:** the work is on `main`, `pnpm check` is green, the behaviour is
covered by a test that runs without Dota 2 or a live API, and what you learned is written
down where the next agent will hit it.

## Committing alongside other agents

Agents commit directly to `main`; there is no review queue. Pull before you start and again
before you push. If someone landed while you worked, reconcile it yourself — leaving it for
the next agent is how a repo stalls.

Write the commit message for someone whose only context is `git log`. If you left part of
the task undone, say what and why in the message.

## Updating a skill

Every area has a skill in `.claude/skills/`. When you finish a task, ask: *did I learn
something that would have saved me time at the start?* If yes, it goes in that area's skill
**in the same commit as the work** — there is no follow-up task, and the next agent in this
area will be someone else.

**Qualifies:** a mistake the docs did not warn you about · a command or incantation that
worked after several that did not · a limit or quirk you measured rather than read · an
approach you tried and abandoned, with why.

**Does not:** restating a design doc · general TypeScript or Rust advice (the
`superpowers:*` skills cover method) · anything true only of the data in your one task.

**It may belong somewhere else.** Contradicts a design doc → fix the doc. Is a decision →
ADR. Is a fact about an external system → a research note in `docs/`. Is "how not to get
this wrong here" → the skill. That last one is the default.

Add it under `## Learnings` with the date and one line of *why*. If it changes how the area
should be worked, promote it into the body as a rule. Full rules: `REPO_SKELETON.md` §13.

## Learnings

*(nothing yet — the first agent to learn something here adds the first entry)*

## See also

`REPO_SKELETON.md` §2 (layout), §8 (scripts), §9 (working agreements), §13 (skills).

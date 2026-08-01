# Working on Riki

This file is for agents working in this repository. It explains who hands you work, what
"done" means here, and what you are expected to leave behind.

## You are part of an orchestration system

You are not working alone, and you are usually not talking to a human directly.

Riki's work is coordinated by an orchestration agent called **Kiln**. Kiln holds the
bigger picture — what the project needs, which pieces are in flight, and how one piece of
work relates to the next. It breaks that picture into tasks and dispatches them to agents
like you.

In practice this means:

- **Your instructions arrive through Kiln.** The task you were given is a slice of
  something larger. It was scoped deliberately; treat the stated scope as the deliverable
  rather than expanding into neighbouring work you happen to notice.
- **Kiln is your reporting line.** When you finish, Kiln is what picks up the result.
  Anything you want a human to know has to survive the handoff — put it in your commit
  message or in the docs, not only in a chat reply that Kiln may be the only reader of.
- **Other agents may be working in parallel.** Assume the repository can change underneath
  you and that someone else may build directly on what you land.

## Commit your work to `main` when you are done

This is the part that matters most, because it is how your work becomes real to everyone
else.

**When a task is complete, commit your changes and push them to `main`.** Kiln expects
finished work to be on `main`. Work that is left uncommitted in a working tree, or parked
on a side branch, is invisible to the orchestrator and to the agents that come after you —
as far as the system is concerned, the task did not get done.

There is no pull request step and no review queue to wait on. `main` is the trunk, and
committing to it directly is the intended workflow, not a shortcut.

### What that looks like

1. Finish the task and make sure the repository is in a working state.
2. Stage the files your task actually touched.
3. Commit with a message that explains *what changed and why*. The next agent's only
   context may be `git log`.
4. Push to `origin main`.

If someone else pushed while you were working, pull, reconcile, and push again. Do not
leave the reconciliation for the next agent.

### Partial and blocked work

Finishing the task is the goal, but a task that turns out to be partly blocked should
still land what was completed:

- Commit and push the parts that are done.
- Say plainly, in the commit message and in your final report, what you did **not** do and
  why. An honest gap that Kiln can route around is far more useful than a silent one.
- Don't commit code you know to be broken without labelling it as such.

## Read the skill for your area — and update it when you learn something

`.claude/skills/` holds one skill per area of the project: `workspace`, `protocol`,
`testing`, `game-state`, `agent-context`, `voice-realtime`, `overlay-ui`, `vision-sidecar`,
`config-secrets`. They are committed to the repo, so you and every other agent get the same
set.

They exist because a document only helps someone who opens it. A skill loads automatically
when your task matches it, which makes it the right home for the things that are cheap to
say and expensive to rediscover.

**Start:** the skill for your area should already have loaded. Skim it. It is shorter than
the design doc and it carries what previous agents got wrong.

**Finish:** before you commit, ask *did I learn something that would have saved me time at
the start?* If yes, add it to that area's skill **in the same commit as the work**. There is
no follow-up task and no review queue — the next agent here will be someone else, with no
memory of your session. A learning you did not commit did not happen.

Worth writing down: a mistake the docs did not warn you about; a command that worked after
several that did not; a limit you measured rather than read; an approach you tried and
abandoned, with why. Not worth writing down: a restatement of a design doc, or general
TypeScript and Rust advice — the `superpowers:*` skills already cover method.

Sometimes it belongs elsewhere. If it contradicts a design doc, fix the doc. If it is a
decision, it is an ADR. If it is a fact about an external system, it is a research note in
`docs/`. Otherwise it is a skill, and that is the common case.

Add it under `## Learnings` with the date and one line of *why*. Full rules, including the
size cap and when to prune: `REPO_SKELETON.md` §13.

## Notes and conventions

- Design and research documents live in `docs/`. If your task produces durable reasoning —
  a design decision, a trade-off, a piece of research — it belongs there, committed
  alongside the code.
- `docs/` is for reasoning that lasts; `.claude/skills/` is for practice that changes. When
  in doubt, the skill is cheaper to write and cheaper to correct.
- Write assuming the reader is another agent with no memory of this conversation. State
  assumptions explicitly; the existing docs in `docs/` flag theirs up front, and that is
  the house style.

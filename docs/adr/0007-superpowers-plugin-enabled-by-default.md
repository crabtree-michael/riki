# Superpowers Plugin — Integration Decision

**Decided:** 2026-08-01
**Status:** Implemented. Live in `.claude/settings.json` at project scope.

> **Scope note:** the task described Superpowers as "the Superpowers plugin from Claude."
> It is not an Anthropic plugin — it is a third-party skills library by Jesse Vincent
> ([obra/superpowers](https://github.com/obra/superpowers)), distributed *through*
> Anthropic's curated marketplace. That distinction drives the sourcing decision below.
> Plugins execute arbitrary code with the invoking user's privileges.

---

## What landed

`.claude/settings.json`, committed to the repo so it applies to every collaborator and
every agent working here:

```json
{
  "extraKnownMarketplaces": {
    "claude-plugins-official": {
      "source": { "source": "github", "repo": "anthropics/claude-plugins-official" }
    }
  },
  "enabledPlugins": { "superpowers@claude-plugins-official": true }
}
```

Project scope is the mechanism Claude Code provides for "shared with everyone on this
repo." User scope would only affect one machine; local scope is gitignored and personal.

## Decision 1: source from the official marketplace, not obra's

Superpowers is published in two places, and both were checked directly rather than
inferred from documentation:

| Marketplace | Plugin source | Pinning |
| --- | --- | --- |
| `claude-plugins-official` (Anthropic) | `obra/superpowers.git` | `sha` `44c9b2d6e889982ac18c27d05a19fefe335194e1` |
| `superpowers-marketplace` (obra) | `obra/superpowers.git` | unpinned — tracks default branch |

The official entry pins an exact commit. The author's own marketplace does not, so every
collaborator would resolve whatever `main` happened to be at install time. For a
dependency that runs code in every session, a reproducible pin across the team is worth
more than getting upstream changes a few days earlier.

Anthropic also curates inclusion in the official marketplace. That is a weak signal, not
an audit, but it is strictly more review than the unpinned path.

## Decision 2: declare `extraKnownMarketplaces` even though it should auto-register

The docs state that Claude Code adds `claude-plugins-official` automatically at startup,
which makes the declaration look redundant. It is not, in practice.

Installing into a fresh environment failed:

```
✘ Plugin "superpowers" not found in marketplace "claude-plugins-official".
```

`claude plugin marketplace list` returned `No marketplaces configured`. The auto-add had
not run, and the install could not proceed until the marketplace was added by hand. That
failure mode is likely wherever a session starts without the usual interactive startup —
containers, CI, headless and cloud runs.

Declaring the marketplace in project settings makes the repo self-contained in those
environments. The docs confirm the two compose rather than conflict: if a marketplace is
already known, the existing copy is used.

## What the plugin costs

14 skills: brainstorming, writing/executing plans, red-green TDD, systematic debugging,
subagent-driven development, requesting/receiving code review, git worktrees, parallel
agent dispatch, verification before completion, and skill authoring.

- **~688 tokens always-on**, added to every session.
- Each skill body loads only when it fires, ranging ~800 tokens (`executing-plans`) to
  ~10.3k (`subagent-driven-development`).
- One `SessionStart` hook, harness-only, no model context cost.

There are no slash commands — the plugin ships `skills/` with no `commands/` directory, so
Claude invokes the skills itself. `using-superpowers` is the entry point that describes
the rest.

## Opting out without touching shared config

`.claude/settings.local.json` (gitignored) overrides project scope for one person:

```json
{ "enabledPlugins": { "superpowers@claude-plugins-official": false } }
```

## Verification

Installed via the supported path, `claude plugin install superpowers@claude-plugins-official
--scope project`, rather than hand-writing the config, then confirmed twice:

1. `claude plugin list` — v6.2.0, scope project, status enabled.
2. A subsequent session loaded all 14 skills namespaced `superpowers:*`, which is the
   project-scoped config actually taking effect rather than a report about it.

## Assumption left open

Superpowers' methodology — mandatory brainstorming before creative work, TDD before
implementation — is opinionated and now applies by default to every agent in this repo.
That suits the orchestration model in `AGENTS.md`, where agents receive scoped tasks and
need consistent habits. If it proves too heavy for small tasks, the lever is per-person
opt-out above, or removing the `enabledPlugins` entry to make it available-but-not-default.

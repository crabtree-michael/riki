# Claude Code Plugin Setup — Superpowers

**Set up:** 2026-08-01
**Status:** Live. `.claude/settings.json` is committed and applies to everyone on the repo.

> **Scope note:** the brief asked to add "the Superpowers plugin from Claude." Superpowers
> is **not** an Anthropic plugin — it is a third-party skills library by Jesse Vincent
> ([obra/superpowers](https://github.com/obra/superpowers)), distributed *through*
> Anthropic's curated marketplace. That distinction matters because plugins execute
> arbitrary code with your user privileges. It was installed anyway, since it is
> unambiguously the plugin the brief meant.

---

## What landed

`.claude/settings.json`, at **project scope** — the mechanism Claude Code uses for config
shared with everyone who clones the repo:

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

Written by `claude plugin install superpowers@claude-plugins-official --scope project`
rather than by hand, then extended with the marketplace block (see below).

`.gitignore` excludes `.claude/settings.local.json` so personal overrides stay personal.
To opt out individually without touching shared config:

```json
{ "enabledPlugins": { "superpowers@claude-plugins-official": false } }
```

## Decision: official marketplace, not obra's

Superpowers is listed in two places, and both were checked directly rather than inferred:

| | `claude-plugins-official` | `superpowers-marketplace` (obra) |
|---|---|---|
| Source pin | commit SHA `44c9b2d` | `url` → repo, no SHA |
| Curation | Anthropic-reviewed | author-maintained |

The official marketplace pins to an exact commit, so every agent and collaborator resolves
the *same* code. Obra's marketplace tracks the branch tip, meaning two agents cloning a
week apart could get different skill definitions. For a repo where parallel agents build on
each other's work, reproducibility wins. The obra marketplace is the place to look for the
`-lab`, `-chrome`, and `episodic-memory` siblings, which the official one does not carry.

## Gotcha: `extraKnownMarketplaces` is not redundant

Anthropic's docs say `claude-plugins-official` is registered automatically at startup, which
implies `enabledPlugins` alone should be enough. **It was not.** The first install attempt
failed:

```
Plugin "superpowers" not found in marketplace "claude-plugins-official".
```

`claude plugin marketplace list` returned `No marketplaces configured`. The auto-registration
had not happened, and the fix was an explicit `claude plugin marketplace add`.

So the marketplace is declared explicitly in project settings. Per Anthropic's docs the two
compose rather than conflict — a declared marketplace that already exists is reused, not
re-cloned. This matters for headless, container, and CI runs, which is the normal case for
agents working in this repo.

## What the plugin actually provides

14 skills, no slash commands (there is no `commands/` directory, so `/superpowers:<x>`
invocations do not exist — Claude loads the skills on its own). `using-superpowers` is the
entry point that explains the others.

`brainstorming`, `writing-plans`, `executing-plans`, `test-driven-development`,
`systematic-debugging`, `subagent-driven-development`, `dispatching-parallel-agents`,
`requesting-code-review`, `receiving-code-review`, `verification-before-completion`,
`using-git-worktrees`, `finishing-a-development-branch`, `writing-skills`,
`using-superpowers`.

Cost is **~688 tokens always-on**, added to every session. Each skill's body loads only when
it fires, ranging from ~800 tokens (`executing-plans`) to ~10.3k
(`subagent-driven-development`). One `SessionStart` hook, harness-only, no model context cost.

Version at install: **6.2.0**.

## Verification

Confirmed three ways, not assumed:

1. `claude plugin list` → `superpowers@claude-plugins-official`, scope project, enabled.
2. `claude plugin details` → the 14-skill inventory and token costs above.
3. A subsequent session loaded all 14 skills namespaced `superpowers:*` — the committed
   project-scope config taking effect end to end.

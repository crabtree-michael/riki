# Riki

Riki is invisible until needed.

## Development environment

This repo ships a shared Claude Code configuration in `.claude/settings.json`. It
registers Anthropic's official plugin marketplace and enables the
[Superpowers](https://github.com/obra/superpowers) plugin (v6.2.0) at project
scope, so every collaborator gets the same agent workflows by default.

Superpowers is a third-party skills library by Jesse Vincent, distributed through
Anthropic's curated `claude-plugins-official` marketplace (pinned to a specific
commit there). It adds 14 skills covering brainstorming, writing and executing
plans, red/green TDD, systematic debugging, subagent-driven development, code
review, git worktrees, and verification before completion. Cost is ~688 tokens
always-on, with each skill's body loaded only when it fires.

### Setup

Claude Code prompts you to install project plugins the first time you trust this
folder. To do it yourself:

```shell
claude plugin install superpowers@claude-plugins-official --scope project
```

Then run `/reload-plugins` (or restart) to activate it. The plugin ships skills
only (no slash commands); Claude picks them up on its own, and the
`using-superpowers` skill is the entry point that explains the rest.

To opt out for yourself without changing the shared config, disable it in
`.claude/settings.local.json` (gitignored):

```json
{ "enabledPlugins": { "superpowers@claude-plugins-official": false } }
```

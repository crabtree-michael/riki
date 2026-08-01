#!/usr/bin/env node
// PreToolUse guard: refuse git commands that skip the hooks (ADR-0008).
//
// pre-commit is the only gate this repo has, so a bypass is not a shortcut — it is the whole
// safety net. Wired from .claude/settings.json; reads the Claude Code hook payload on stdin and
// answers with a permission decision.
//
// Quoted text and heredoc bodies are stripped before matching, so a commit MESSAGE that mentions
// --no-verify is not mistaken for the flag itself. That is not hypothetical: this repo documents
// the flag, and `git commit -F - <<'EOF'` puts the whole message inside the command string.

import { readFileSync } from 'node:fs';

/** Drop `<<EOF ... EOF` bodies — prose, not flags. */
function stripHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let terminator = null;

  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue; // body line: drop it
    }
    out.push(line);
    const open = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (open) terminator = open[2];
  }
  return out.join('\n');
}

/** Remove quoted spans so flags inside a commit message are not treated as real flags. */
function stripQuoted(cmd) {
  return stripHeredocs(cmd)
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** @returns {string|null} reason to block, or null to allow. */
function reasonToBlock(rawCommand) {
  const cmd = stripQuoted(rawCommand);

  // `git commit` / `git push`, allowing global options in between (`git -c foo=bar commit`).
  const subcommand = /\bgit\b[^\n;|&]*?\b(commit|push)\b([^\n;|&]*)/g;

  for (const match of cmd.matchAll(subcommand)) {
    const verb = match[1];
    const rest = match[2];

    if (/(^|\s)--no-verify(\s|$|=)/.test(rest)) {
      return `\`git ${verb} --no-verify\` skips the pre-commit gate`;
    }
    // `-n` means --no-verify for commit, but --dry-run for push, which is harmless.
    // Matches bundled short flags too (`-nm "msg"`).
    if (verb === 'commit' && /(^|\s)-[a-zA-Z]*n[a-zA-Z]*(\s|$)/.test(rest)) {
      return '`git commit -n` is `--no-verify`, which skips the pre-commit gate';
    }
  }

  // Equivalent bypasses that do not use a flag at all.
  if (/core\.hooksPath/.test(cmd)) {
    return 'overriding `core.hooksPath` disables the hooks entirely';
  }
  if (/\bLEFTHOOK=(0|false)\b/.test(cmd)) {
    return '`LEFTHOOK=0` disables the hooks entirely';
  }
  return null;
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // Unparseable payload is not this guard's problem; do not block.
}

const reason = reasonToBlock(payload?.tool_input?.command ?? '');
if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked: ${reason}.\n\n` +
          'This repo has no CI — pre-commit is the only thing checking anything ' +
          '(REPO_SKELETON.md §8.2, ADR-0008). If the gate is failing, fix what it is ' +
          'reporting. If the gate itself is wrong, change lefthook.yml in a commit that ' +
          'says why. Do not go around it.',
      },
    }),
  );
}
process.exit(0);

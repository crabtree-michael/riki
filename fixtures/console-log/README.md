# `fixtures/console-log/`

**These are synthetic.** No one has run Dota 2 with `-condebug` and captured the result — the
dev platform has no client, and `dota2-state-capture-design.md` §2.3 lists "exactly which events
reach `console.log` on current builds" as an open question rather than a known.

So the lines here encode what the matchers in `packages/log-tail/src/matchers/` were *written
against*, which is a plausible reconstruction from community reports, not ground truth. They are
still worth having: they pin the tailer's line-splitting, the registry's first-match-wins order,
and the privacy classification, none of which depend on the format being right.

**What to do with a real capture.** Replace these files, then run the matcher tests. Every
failure is a matcher to fix, and that is the intended workflow — the registry exists so that a
format change breaks one small file. If it turns out kills never reach `console.log`, delete
`killfeed.ts` and its fixture lines; `enemies.*.alive` then falls to the top-bar CV that the
`enemy_liveness` precedence class already admits as a gap-filler.

**Scrub before committing.** A real `console.log` contains other people's chat (dota2 §7) and can
contain Steam profile names. Neither belongs in a git history.

## Files

- `chat-and-events.log` — one line of every form the matchers recognise, plus engine noise that
  must match nothing.
- `rotation-boundary.log` — the pre-rotation content used by the tailer's rotation test.

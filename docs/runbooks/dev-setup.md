# Runbook: development setup

## Prerequisites

- **Node 22+** and **pnpm 11+**
- **Rust 1.82+** via [rustup](https://rustup.rs) — needed for `crates/`. Without it the cargo
  steps in `pnpm check` skip with a notice rather than failing, so TypeScript-only work does not
  need a toolchain.
- **git-lfs** — for the frame fixtures. Without it, tests that need frames skip with a message.
- Optional but wanted: [gitleaks](https://github.com/gitleaks/gitleaks) for the pre-push secret
  scan. Without it the hook skips with a notice, and there is no CI behind it — so on a machine
  without gitleaks, nothing checks for a committed secret at all.

## Fresh clone

```shell
pnpm setup
```

That installs dependencies, fetches LFS fixtures, generates protocol types, installs git hooks,
and creates `.env` from `.env.example`.

One line still needs you, and only for live voice:

```shell
RIKI_OPENAI_API_KEY=sk-...
```

Leave it blank to run fixtures-only. `pnpm test`, `pnpm check`, and `pnpm dev:replay` all work
with no key at all — see [ADR-0006](../adr/0006-env-var-api-key-for-alpha-beta.md).

## Day to day

| Command           | Does                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `pnpm check`      | lint + format + typecheck + test + codegen-clean. **The pre-commit hook runs this for you and blocks the commit if it fails (ADR-0008). There is no CI.** |
| `pnpm test`       | Vitest + `cargo test`. No game, no network, no GPU, no API key.                               |
| `pnpm dev:replay` | The whole app driven from fixtures. No Dota and no API key required.                          |
| `pnpm dev`        | Builds and launches the Electron app. No key needed — and none is read; see below.            |

The full list is [REPO_SKELETON.md](../../REPO_SKELETON.md) §8.1. If a command you need is not
there, it should be — add it under a canonical name rather than inventing a second one.

## Running the app against a real game

`pnpm dev` starts the tray, the hidden overlay window, the global hotkey and the GSI listener on
`127.0.0.1:53101`. **One step is still manual:** nothing writes Dota's
`gamestate_integration_riki.cfg` — `tools/setup-gsi-cfg` is named in `.env.example` and does not
exist — so until it does, write it yourself.

Take the token the app generated on first run:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Riki/gsi-token` |
| Linux | `~/.config/Riki/gsi-token` |
| Windows | `%APPDATA%\Riki\gsi-token` |

and drop this into `<steam>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/`:

```keyvalues
"Riki"
{
    "uri"           "http://127.0.0.1:53101/"
    "timeout"       "5.0"
    "buffer"        "0.1"
    "throttle"      "0.1"
    "heartbeat"     "30.0"
    "auth"          { "token" "PASTE_THE_TOKEN_HERE" }
    "data"
    {
        "provider" "1"  "map" "1"  "player" "1"  "hero" "1"
        "abilities" "1" "items" "1" "buildings" "1" "draft" "1"
    }
}
```

Restart Dota. To check the listener without launching a game, POST a fixture line at it — the
recipe is in the `game-state` skill.

Settings live in `settings.json` beside that token. `.env` is **not** read yet: `packages/config`
is [REPO_SKELETON.md](../../REPO_SKELETON.md) §10 step 3 and is still a skeleton, so
`RIKI_GSI_PORT` and friends are ignored, and `RIKI_OPENAI_API_KEY` has nowhere to go — which is
why there is no voice yet.

## Seeing why Riki said nothing

Riki is built to fail quiet, so a working one and a broken one look the same from outside. The
**inspector** is the window that tells them apart: the world model with every fact's provenance and
age, every detection with all thirteen gates' verdicts on it, the snapshot and brief exactly as
composed for each turn, and every fault the app reports but currently cannot log.

It is off by default and turned on in the same `settings.json` as everything else, or with
`RIKI_DEBUG=1`:

```jsonc
{ "debug": { "enabled": true } }
```

Restart the app, then **Riki ▸ Open Inspector…** in the tray. The row is not rendered at all when
the flag is off.

Three things about reading it:

- **Freeze early.** Frames arrive at 4 Hz and an interesting gate ladder lasts one tick. The Freeze
  button holds the drawn frame while main keeps collecting, so unfreezing shows the present rather
  than resuming a replay.
- **`not_in_match` ticks are hidden by default,** with a count of how many. During a draft or a
  post-game screen the detectors keep firing and gate 1 refuses every one; those ticks are correct
  and there are thousands of them. Switch the filter off if gate 1 is what you are debugging.
- **The Controls panel writes** (ADR-0037). Every number in `packages/events/src/config.ts` is a
  stepper, every detector and gate is a switch, and moving one takes effect on the next tick — no
  restart, and the latch set and cooldowns you were watching survive it. Nothing is written to
  `settings.json`, so a restart is also how you undo everything; **Reset all** is the quicker way.
  If the header says *N overrides*, everything below it is a reading of a tuned app: check that
  before reporting behaviour.

Leave it off otherwise. With it on the app holds rendered snapshots, briefs and coach transcripts in
memory, and evaluates all thirteen gates against every candidate rather than the winner alone —
[`docs/design/debug-inspector.md`](../design/debug-inspector.md) §6 has the reasoning.

## What is not scaffolded yet

`pnpm dev:replay`, `pnpm test:e2e`, and `pnpm build` print what they are blocked on and exit
non-zero. The scaffolding order in [REPO_SKELETON.md](../../REPO_SKELETON.md) §10 says which step
unblocks each.

The app itself runs, with three gaps, each documented at its seam:

- **No speech.** The Realtime session lives in a voice renderer that does not exist
  (`voice-input-architecture.md` §7.3), and the API key is unreachable until step 3. Everything up
  to the point of speaking runs — see `apps/desktop/src/main/shell/silent-session.ts`.
- **No push-to-talk.** Electron's `globalShortcut` is key-down only, so tap-to-latch works and
  holding the key does not (`ui-design.md` §6.4).
- **No screen reading.** `crates/riki-vision` is an empty `main()`, so vision is off by default.

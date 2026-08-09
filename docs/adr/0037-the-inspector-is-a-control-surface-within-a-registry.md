# ADR-0037: The inspector is a control surface, within a registry

**Status:** Superseded by [ADR-0042](0042-riki-answers-questions-instead-of-deciding-when-to-speak.md), 2026-08-09 — every row in the registry described a threshold, a weight or a gate in `packages/events`, and that package is gone. The registry mechanism went with its contents rather than being kept empty; the distinction it drew between a *setting* and an *action* survives in ADR-0039, which is now the inspector’s only write surface.
**Date:** 2026-08-02

**Amends:** [ADR-0032](0032-the-inspector-observes-by-decoration.md), whose Decision reads *"read-only
by construction: `RikiDebugBridge` has two methods, `ready` and `fault`, and there is deliberately no
way to set a switch, force an evaluation or replay a tick from it."* The decoration half of that ADR
is untouched and still load-bearing; the read-only half is replaced by the narrower rule below.

## Context

ADR-0032 built a window that shows, several times a second, every candidate the detectors produced,
its salience to three decimals, and all thirteen gates' verdicts on each — beside the switches,
cooldowns and thresholds those verdicts were decided against. It is very good at the question it was
built for. It is also very good at producing the *next* question, and it had no answer to it:

> `ult_ready` scored 0.281 and `speakThreshold` is 0.3. What happens if it is 0.25?

The answer was: edit `packages/events/src/config.ts`, rebuild, restart the app, and replay a match —
during which the world model, the latch set, the cooldown clocks and the intensity fold all start
from nothing, so the moment being investigated has to be reached again before the changed number
means anything. Each iteration is minutes, and the state that made the moment interesting is gone.

That is not a missing convenience. `coaching-architecture.md` §6.2 refuses to give coefficients and
§15 item 1 says why — *"they are unmeasurable without a replayed corpus and a human judging the
output"* — and §16 step 3 is the ticket to measure them. The inspector was built to serve that
ticket, and a tool that makes the numbers legible but not movable serves half of it.

Against that: the reason ADR-0032 gave for read-only is real and has not weakened. A debug window
that can poke the thing it inspects produces readings nobody can act on, and this is a product whose
worst failure mode is Riki talking when it should not. It is also the only renderer a person can
focus and type into, so it is the widest privilege surface in the app.

## Decision

**The inspector can change settings, and only through a registry of named controls that does nothing
until somebody clicks.** Four properties, each enforced somewhere rather than remembered:

**1. Inert unless driven.** With no `control` intent, every seam behaves exactly as it did before:
the live `TriggerConfig` answers what `DEFAULT_TRIGGER_CONFIG` answers, the thirteen live gates refuse
what `GATES` refuse, the eight live detectors detect what `DETECTORS` detect. `shell.test.ts` still
replays a fixture with the flag off and on and asserts the same utterances, and now also asserts that
one moved control changes them.

**2. Interposition, not reach-in.** The mechanism is ADR-0032's own, pointed one step further.
`TriggerConfig`, `Gate[]` and `EventDetector[]` are all things the composition root already injects,
so the inspector changes behaviour by *choosing what to inject* — a getter-backed config, gates that
consult an enabled set, detectors that return nothing when switched off. **`packages/events` is still
unchanged by this feature.** It has no setter for a threshold, no way to disable a gate, and nothing
in it knows a debug window exists.

**3. A registry, not a surface.** `main/debug/controls.ts` holds one row per reachable setting,
derived from `TriggerConfig`, `COACH_EVENT_KINDS` and `GATES` rather than typed out — a `Record`
total over the numeric keys, so a number added to `config.ts` fails the compiler until it is given a
range. A `control` intent names a row id. There is no path from an intent to an arbitrary field, and
no `evaluate`, no `speak`, no "replay this tick".

**4. The player's instructions are not settings.** The `quiet_mode` and `muted` gates are locked and
displayed as locked. The inspector may make Riki quieter by any route it likes and louder only within
what the player allowed. Mute keeps the single producer [ADR-0028](0028-mute-has-one-producer-the-menu-row.md)
gave it.

### What is reachable

Every number in `packages/events/src/config.ts` — the twenty-one scalars, the eight kind weights and
the eight kind cooldowns — plus each detector and each gate as an on/off, plus the two coach settings
the shell owns: `coach.mode` and unprompted speech. Sixty-odd controls, in collapsible groups.

Choosing "every number in that file" rather than a curated handful is deliberate. The file exists so
that tuning is *"a diff to one file against a golden corpus, rather than a hunt through eight
detectors"*; the same argument makes it the right unit for the window that does the tuning, and a
curated list would be a second opinion about which numbers matter, maintained by hand.

### Nothing is persisted, except the coach

Overrides live for the run of the app. The trigger numbers are not `packages/config` keys at all and
should not become them: §16 step 3 wants the outcome of tuning to be a reviewed diff to `config.ts`
against a corpus, not a `settings.json` on one machine that silently makes one developer's Riki
different from everyone else's. Unprompted speech is a privacy default REPO_SKELETON.md §7.2 requires
to ship off, and a debug window able to make "on" sticky is exactly how that default would drift.

`coach.mode` is the exception, and not one this feature makes: the control calls the shell's
`setCoachMode`, which persists through `onCoachModeChanged` because the tray's Coach row does. A
panel and a tray checkbox that disagreed about which coach is running would be worse than either
being wrong alone.

## Consequences

**A tuning session is now a session.** Move a threshold, watch the next tick decide differently
against the same latch set and the same cooldowns, move it back. The gate grid keeps showing all
thirteen verdicts including a switched-off gate's, so *"if I turn `kind_cooldown` back on, this one
dies again"* is readable rather than inferred.

**Every reading now needs a caveat, so the window supplies it.** An overridden control is marked, its
group is badged, and the header carries a count in the loudest tone the stylesheet has. The realistic
failure this introduces is somebody moving `speakThreshold` to 0.05, forgetting, and reporting that
Riki will not stop talking; the count is where that is caught. `ShellTelemetry.debugOverride` records
each change so it survives into a log the day `packages/telemetry` lands — the one place it is not
already visible.

**The renderer is no longer unprivileged.** It was the app's least privileged process and now it is
its widest. Two boundaries answer two different questions: preload asks whether a payload is *shaped*
like a control intent, which is all a boundary with no registry can honestly check, and main asks
whether the id names a registered, unlocked control. `electron-window.ts`'s sender check matters more
than it did — a `control` from the overlay's `webContents` must not be honoured just because it
parses.

**The window is still off by default**, and everything ADR-0032's default protected it still
protects. `debug.enabled` is not itself a control, so the inspector cannot switch itself on, and with
it off no registry is built and no wrapper is on the trigger path.

**The engine captures its collaborators once**, so the live views are stable objects whose answers
change rather than objects that get replaced. Rebuilding the driver on every click would also work
and would throw away the latch set and the cooldown clocks — the state somebody is watching while
they turn the knob. `controls.test.ts` asserts the *same* object answers differently after an
`apply`, because a test that fetched a fresh one would pass against the broken design.

## Alternatives rejected

**Leave it read-only and add a hot-reload of `config.ts`.** No renderer privilege at all, and it was
the first idea. It restarts nothing, but it also preserves nothing: the numbers would change under a
running engine with no record in the frame of what they now are, so the window would be displaying a
config it could not name. Every override being *in the frame* is what makes a reading interpretable,
and that is a property of putting the registry behind the same wire as everything else.

**Expose the settings through `settings.json` and a file watcher.** Persistent by construction, which
is the wrong default here for the two reasons above, and it makes the trigger numbers config keys —
a `packages/config` change, a schema, an environment variable each, and a migration story for numbers
whose whole point is that nobody knows them yet.

**Add setters to `EventEngine`.** `setSpeakThreshold`, `clearLatches`, `setDetectorEnabled`. Smaller
diff in `main/debug/`, and it is the mutable-state version of the hooks ADR-0032 rejected: it puts
debug-only surface on the package whose invariants are the reason the gates can be trusted, and an
accessor on private state is an invitation to write to it from somewhere that is not a debug window.
The interposition above gets the same reach with `packages/events` untouched.

**A free-text field per number instead of a stepper.** What a tuner would ask for, and it cannot work
in this document: the inspector redraws whole at 4 Hz (ADR-0032), so an `<input>` being typed into has
its value replaced mid-keystroke. Steppers are atomic. Making the Controls panel exempt from the
redraw was the alternative and it reintroduces the stale-node bug class in the one window whose only
job is to be believed.

**Actions as well as settings — "force a tick", "clear the latches", "say this now".** Each is useful
and none is a setting. They need surface on `EventEngine` and `CoachingAgent` that the previous
alternative just rejected, and "the window can drive the app" is a materially different claim from
"the window can configure it". Left out, and left as a decision rather than an extension.

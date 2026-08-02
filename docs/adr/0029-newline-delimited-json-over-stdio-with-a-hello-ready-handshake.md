# ADR-0029: Newline-delimited JSON over stdio, with a hello/ready handshake

**Status:** Accepted
**Date:** 2026-08-02

## Context

`crates/riki-vision` is a separate process so that a crash in capture or CV cannot take the voice
agent down ([dota2-state-capture-design.md](../design/dota2-state-capture-design.md) §3). Something
has to carry messages across that boundary, and REPO_SKELETON.md §4 already fixes two of its
properties: zod is the source of truth for the shape, and **every message is versioned**, because
the app and the sidecar are routinely different builds during development and a mismatch must
produce a clear error rather than a confusing parse failure three layers down.

What was undecided was the frame — how a message is delimited on the wire — and what the very
first exchange looks like.

## Decision

**Newline-delimited JSON over the child's stdin and stdout, one message per line, flushed per
message.** stdout carries protocol and nothing else; everything human-readable goes to stderr.

**Every message carries `v` and `type`, and those two fields are frozen for all time.** Both sides
parse the envelope first, check `v`, and only then parse the content. That ordering is what makes a
mismatch reportable *as* a mismatch: a message from a version we do not understand is still
readable enough to say so.

**The first message is `hello`, answered by `ready`.** Nothing that arrives before a matching
`hello` is acted on; it is reported as `handshake_required` and dropped. A version mismatch is
answered with a fatal `problem` and then exit code `2` — distinct from a panic's `101` and from a
clean `0`, so a supervisor's log line says which happened. A closed stdin is a shutdown, so a
crashed app cannot leave an orphaned sidecar holding a capture session.

## Consequences

- A developer can drive the sidecar by hand — `printf '{"v":1,…}' | riki-vision` — and read what it
  says. That is most of why this slice could be verified at all on a box with no display.
- `apps/desktop/src/main/sidecar` already buffers the child's stdout into whole lines, so the app
  side needed no new framing. The line splitter it had is now load-bearing for message integrity.
- A JSON parse per message costs something. At the 1–5 Hz this protocol runs at, against a budget
  of ≤3% of one core, it is not measurable — but it would be at frame rate, and a future
  high-frequency channel is a reason to revisit this rather than to widen it.
- Freezing `v` and `type` costs a little expressiveness forever. It buys the one property that
  makes version skew survivable, which during parallel development is the common case.
- **Nothing on either side may `println!` or `console.log` to stdout in these processes.** The rule
  is now enforced by convention and by one integration test that asserts every line of stdout
  parses as protocol.

## Alternatives rejected

- **Length-prefixed binary frames (protobuf, MessagePack, bincode).** Faster and unambiguous, but
  unreadable by hand and a second schema pipeline. The performance it buys is not on any budget we
  have; the debuggability it costs is what this slice needed most.
- **A local socket or named pipe.** Three platform implementations for a channel that already
  exists on every one of them, and it gives up the property that killing the parent closes the
  child's stdin.
- **Waiting for `ready` before sending anything else.** The app sends `hello`, `capture.configure`
  and `capture.start` together on spawn. A pipe preserves order, so the handshake is established
  before the sidecar reads the second line, and waiting would have required a write path back
  through the codec seam for no behavioural gain.
- **Exiting on a malformed line.** The sidecar is supervised and would be restarted, so one bad
  line would become a restart loop that also loses capture. Malformed lines are reported as
  non-fatal problems and counted.

See [REPO_SKELETON.md](../../REPO_SKELETON.md) §4, the `protocol` skill, and
[state-capture-architecture.md](../design/state-capture-architecture.md) §4.3.

/**
 * The vision sidecar, as ports.
 *
 * `crates/riki-vision` runs as a separate process so a crash in capture or CV cannot take the
 * agent down (`state-capture-architecture.md` §4.3, dota2 §3). That requirement is the reason this
 * directory exists: something has to notice the crash, and the something has to be testable
 * without spawning a real binary.
 *
 * So the process itself is behind `ChildProcessPort`. `node-process.ts` is the one implementation
 * that imports `node:child_process`; every test drives a fake, which is what makes "restarts with
 * backoff after three crashes" a Tier 1 assertion rather than a thing somebody once watched
 * happen.
 *
 * ## What is deliberately missing
 *
 * **The protocol.** `packages/protocol` is REPO_SKELETON.md §10 step 2 and has not landed — it
 * exports `{}` — and `crates/riki-ipc` is a doc comment. There is therefore no handshake to
 * perform and no message to parse, and inventing either here would put the wire format in the
 * wrong package and guarantee a rewrite.
 *
 * What is here instead is the seam it plugs into: `SidecarCodec` turns a line of the child's
 * stdout into an `Observation<'cv.detections'>` or into nothing. The default codec parses nothing
 * and counts every line it was handed, so the day the protocol lands the change is one file and
 * the supervisor above it does not move.
 */

import type { MonoMs, Observation } from '@riki/world-model';

/** A spawned process, narrowed to what a supervisor needs. */
export interface ChildProcessHandle {
  /** Line-oriented. The implementation owns the buffering; a partial line never arrives here. */
  onStdout(listener: (line: string) => void): () => void;
  onStderr(listener: (line: string) => void): () => void;
  /** Exit *or* spawn failure — from a supervisor's point of view they are the same event. */
  onExit(listener: (reason: string) => void): () => void;
  write(line: string): void;
  /** SIGTERM, then SIGKILL after a grace period. Resolves once the process is gone. */
  kill(): Promise<void>;
}

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export interface ChildProcessPort {
  /** Throws — or returns a handle that immediately exits — if the binary is missing. */
  spawn(request: SpawnRequest): ChildProcessHandle;
}

/**
 * One line of the sidecar's stdout → at most one observation.
 *
 * Returning `null` means *not a message we know*, which is the correct answer for a log line, a
 * panic trace, or a protocol version we do not speak. It is counted, never thrown on: a sidecar
 * that prints something unexpected must not take the coaching path down with it.
 */
export interface SidecarCodec {
  decode(line: string, at: MonoMs, seq: number): Observation | null;
  /** The handshake, sent once on spawn. Empty until `@riki/protocol` defines one. */
  hello(): readonly string[];
}

export interface SidecarStats {
  readonly spawns: number;
  readonly exits: number;
  readonly linesIn: number;
  readonly linesUndecodable: number;
  readonly lastExitReason: string | null;
}

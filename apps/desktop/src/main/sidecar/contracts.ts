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
 * ## The codec
 *
 * `SidecarCodec` turns a line of the child's stdout into one of three things, and the three-way
 * split is load-bearing rather than tidiness. A `ready` or a `problem` is **handled** — fully
 * understood, but not an observation — while a panic trace is **undecodable**. Collapsing those
 * two into "returned nothing" would make `linesUndecodable` count every successful handshake,
 * and that counter is the only thing that distinguishes a sidecar which is talking and not being
 * understood from one that has gone silent.
 *
 * `protocol-codec.ts` is the implementation, over `@riki/protocol`. `NULL_CODEC` remains for
 * tests that care about the supervisor rather than about the wire.
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

/** What one line of the sidecar's stdout turned out to be. */
export type DecodedLine =
  /** A CV batch for the world model. */
  | { readonly kind: 'observation'; readonly observation: Observation }
  /** Understood and dealt with — a handshake reply, a reported problem. Not a fact. */
  | { readonly kind: 'handled' }
  /** A log line, a panic trace, or a protocol version we do not speak. Counted, never thrown on. */
  | { readonly kind: 'undecodable' };

/**
 * One line of the sidecar's stdout → at most one observation.
 *
 * Total by construction: a sidecar that prints something unexpected must not take the coaching
 * path down with it, so there is no throwing path out of `decode`.
 */
export interface SidecarCodec {
  decode(line: string, at: MonoMs, seq: number): DecodedLine;
  /** Sent once on spawn, in order: the handshake, and whatever setup follows it. */
  hello(): readonly string[];
}

export interface SidecarStats {
  readonly spawns: number;
  readonly exits: number;
  readonly linesIn: number;
  /** Understood but not an observation: handshake replies and reported problems. */
  readonly linesHandled: number;
  readonly linesUndecodable: number;
  readonly lastExitReason: string | null;
}

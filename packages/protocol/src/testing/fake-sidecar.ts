/**
 * `FakeVisionSidecar` — the Rust process, as a `ChildProcessPort`.
 *
 * REPO_SKELETON.md §5.2 names this as one of the four shared fakes and says what it is for:
 * *"emits scripted protocol messages, including crashes, stalls, and low-confidence output"*. The
 * reason it is worth building is narrower than "so there is a fake". `crates/riki-vision` can only
 * run its capture backends on a Mac, and the one backend that works anywhere — `--backend replay`
 * — has no atlas and so emits nothing but region digests. So until this file existed, **no machine
 * anywhere could execute the vision → world model → coaching edge of the loop**, and it turned out
 * not to work (ADR-0035).
 *
 * ## It is a port, not a source
 *
 * The seam chosen is `ChildProcessPort` — the narrowest thing between Electron main and the
 * sidecar, and the one place `node:child_process` is reached for. Everything above it is the real
 * thing: `createSidecarSource` supervises it, `createProtocolCodec` speaks to it, the observation
 * bus carries what comes back, and `SourceSupervisor` restarts it with real backoff when it dies.
 * A fake that implemented `SidecarSource` instead would have been easier to write and would have
 * tested none of that.
 *
 * The port shape is declared structurally here rather than imported, because it belongs to
 * `apps/desktop/src/main/sidecar/contracts.ts` and this package may not depend on the app. TypeScript's
 * structural typing makes the two interchangeable; if they drift, the app's own `processes:` wiring
 * stops compiling, which is where anyone would want to find out.
 *
 * ## It really does the handshake
 *
 * `admit()` below mirrors `crates/riki-ipc/src/handshake.rs`: a command that arrives before `hello`
 * is answered with a `handshake_required` problem and *not acted on*, a second `hello` is answered
 * again rather than complained about, and a version it does not speak is fatal. Commands are
 * decoded with `decodeSidecarCommand` — the same version check and the same schema the Rust side
 * runs. A fake that waved its own app's commands through would only ever agree with itself.
 *
 * ## Time is the caller's
 *
 * `step()` and `drain()` are the hand-crank, and `speed: 0` — no timer at all — is the default, for
 * the reason `FakeGsiSource` has the same pair: a test that waits out a scripted 30 s stall is a
 * test nobody runs. `speed > 0` replays the script against real wall-clock gaps, which is what
 * driving the app by hand wants.
 */

import {
  type CaptureConfig,
  type ProblemKind,
  type SidecarCommand,
  type SidecarEvent,
  type SidecarIdentity,
  decodeSidecarCommand,
  encodeMessage,
} from '../index.js';
import { PROTOCOL_VERSION } from '../version.js';

// ---------------------------------------------------------------------------------------------
// The port shape, structurally
// ---------------------------------------------------------------------------------------------

/** A spawned process, narrowed to what a supervisor needs. Mirrors `ChildProcessHandle`. */
export interface FakeProcessHandle {
  onStdout(listener: (line: string) => void): () => void;
  onStderr(listener: (line: string) => void): () => void;
  onExit(listener: (reason: string) => void): () => void;
  write(line: string): void;
  kill(): Promise<void>;
}

/** Mirrors `SpawnRequest`. */
export interface FakeSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

/** Mirrors `ChildProcessPort`. */
export interface FakeProcessPort {
  spawn(request: FakeSpawnRequest): FakeProcessHandle;
}

// ---------------------------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------------------------

/**
 * One thing the fake sidecar does, at a moment in the recording.
 *
 * A **stall** is deliberately not a step. It is the absence of one: a gap in `atMs` under
 * `speed > 0`, or simply not calling `step()` under the hand-crank. Modelling it as a step would
 * have meant a fake that could stall only in ways somebody remembered to script, when the failure
 * worth testing — `SIDECAR_QUIET_MS` turning `live` into `degraded` — is about a sidecar that stops
 * doing anything at all.
 */
export type VisionStep =
  /** Write a protocol line to stdout. */
  | { readonly atMs: number; readonly event: SidecarEvent }
  /** Write a line to stderr. Not protocol: a log line, a panic trace. */
  | { readonly atMs: number; readonly stderr: string }
  /** Die. `reason` reaches the supervisor exactly as a real exit would. */
  | { readonly atMs: number; readonly exit: string };

export interface VisionScript {
  readonly steps: readonly VisionStep[];
}

export interface FakeVisionSidecarOptions {
  /** Replayed in order once `capture.start` arrives. */
  readonly script: VisionScript;
  /** What this fake answers `hello` with. Defaults to a `fake` backend that works. */
  readonly identity?: SidecarIdentity;
  /**
   * How much faster than real time to replay, as a multiplier of the recorded `atMs` gaps. `0` —
   * the default — means "only when the caller says", which is what a unit test wants.
   */
  readonly speed?: number;
  /**
   * Start the script over when it runs out, so a long session keeps seeing the map.
   *
   * Off by default because a test wants to reach the end and assert on it. `pnpm dev` with
   * `RIKI_FAKE_VISION=1` wants the opposite: a sidecar that goes permanently silent after eight
   * seconds is a sidecar the health poll reports as `degraded` for the rest of the session.
   */
  readonly loop?: boolean;
}

/** What a test asks the fake about afterwards. */
export interface FakeVisionStats {
  /** How many times the app spawned a process. Restarts included — that is the point of it. */
  readonly spawns: number;
  /** Every command line the app wrote, decoded. Undecodable lines are counted, not kept. */
  readonly commands: readonly SidecarCommand[];
  readonly undecodableCommands: number;
  /** The last `capture.configure` accepted after a handshake. Null if none was. */
  readonly captureConfig: CaptureConfig | null;
  readonly handshakes: number;
}

export interface FakeVisionSidecar extends FakeProcessPort {
  /** Emits the next scripted step; false once the script is exhausted and not looping. */
  step(): boolean;
  /** Emits everything remaining, ignoring the recorded timing. Returns how many steps ran. */
  drain(): number;
  readonly remaining: number;
  /** True between `capture.start` and `capture.stop` or an exit. Nothing is emitted otherwise. */
  readonly capturing: boolean;
  stats(): FakeVisionStats;
}

export const FAKE_IDENTITY: SidecarIdentity = {
  name: 'riki-vision',
  version: '0.0.0-fake',
  platform: 'fake',
  backend: 'fake',
  backendAvailable: true,
};

// ---------------------------------------------------------------------------------------------

export function createFakeVisionSidecar(opts: FakeVisionSidecarOptions): FakeVisionSidecar {
  const identity = opts.identity ?? FAKE_IDENTITY;
  const speed = opts.speed ?? 0;

  const commands: SidecarCommand[] = [];
  let spawns = 0;
  let undecodableCommands = 0;
  let handshakes = 0;
  let captureConfig: CaptureConfig | null = null;

  /** The one live process, or null between a death and the supervisor's next spawn. */
  let current: FakeProcess | null = null;

  interface FakeProcess {
    readonly stdout: Set<(line: string) => void>;
    readonly stderr: Set<(line: string) => void>;
    readonly exits: Set<(reason: string) => void>;
    established: boolean;
    capturing: boolean;
    index: number;
    timer: ReturnType<typeof setTimeout> | null;
    dead: boolean;
  }

  function emit(process: FakeProcess, event: SidecarEvent): void {
    const line = encodeMessage(event);
    for (const listener of [...process.stdout]) listener(line);
  }

  function die(process: FakeProcess, reason: string): void {
    if (process.dead) return;
    process.dead = true;
    process.capturing = false;
    if (process.timer !== null) clearTimeout(process.timer);
    process.timer = null;
    if (current === process) current = null;
    for (const listener of [...process.exits]) listener(reason);
  }

  function problem(kind: ProblemKind, message: string, fatal = false): SidecarEvent {
    return { v: PROTOCOL_VERSION, type: 'problem', problem: { kind, fatal, message } };
  }

  /**
   * One decoded line → what the sidecar does about it.
   *
   * The mirror of `crates/riki-ipc/src/handshake.rs`. Deliberately literal rather than
   * paraphrased: this is the only place the app's handshake is exercised against a peer that can
   * refuse it, so a fake that were merely permissive would make `hello`-first look verified.
   */
  function admit(process: FakeProcess, line: string): void {
    const decoded = decodeSidecarCommand(line);

    if (!decoded.ok) {
      if (decoded.reason === 'version') {
        emit(
          process,
          problem(
            'protocol_version_mismatch',
            `the app speaks protocol v${String(decoded.theirs)}; this fake speaks v${String(PROTOCOL_VERSION)}.`,
            true,
          ),
        );
        die(process, 'exited with code 2');
        return;
      }
      // Reported and dropped, never fatal: exiting on one bad line turns a cosmetic bug in the app
      // into a restart loop that also loses capture.
      undecodableCommands += 1;
      emit(process, problem('malformed_message', decoded.detail));
      return;
    }

    const command = decoded.command;
    commands.push(command);

    if (command.type === 'hello') {
      // Answered again rather than complained about, so an app that lost track of the handshake
      // can re-establish it instead of having to respawn us.
      process.established = true;
      handshakes += 1;
      emit(process, { v: PROTOCOL_VERSION, type: 'ready', sidecar: identity });
      return;
    }

    if (!process.established) {
      emit(
        process,
        problem('handshake_required', `${command.type} arrived before hello and was ignored`),
      );
      return;
    }

    switch (command.type) {
      case 'capture.configure':
        captureConfig = command.config;
        return;
      case 'capture.start':
        process.capturing = true;
        schedule(process);
        return;
      case 'capture.stop':
        process.capturing = false;
        if (process.timer !== null) clearTimeout(process.timer);
        process.timer = null;
        return;
      case 'shutdown':
        die(process, 'exited with code 0');
        return;
    }
  }

  /** Run one step of the script against `process`. False when there is nothing left to run. */
  function runStep(process: FakeProcess): boolean {
    const steps = opts.script.steps;
    if (process.index >= steps.length) {
      if (opts.loop !== true || steps.length === 0) return false;
      process.index = 0;
    }
    const step = steps[process.index];
    if (step === undefined) return false;
    process.index += 1;

    if ('event' in step) emit(process, step.event);
    else if ('stderr' in step) for (const l of [...process.stderr]) l(step.stderr);
    else die(process, step.exit);
    return true;
  }

  /**
   * The timed path, used only when `speed > 0`.
   *
   * Recursive `setTimeout` rather than one interval: the gaps in a script are uneven, and a
   * sidecar that emitted evenly would hide exactly the stall the script was written to produce.
   */
  function schedule(process: FakeProcess): void {
    if (speed <= 0 || process.dead || !process.capturing) return;
    const steps = opts.script.steps;
    const next = steps[process.index] ?? (opts.loop === true ? steps[0] : undefined);
    if (next === undefined) return;

    const previous = steps[process.index - 1];
    // A wrap makes `next.atMs - previous.atMs` negative. Reusing the script's own first gap keeps
    // a looping fake at its recorded rate instead of firing one pass with no delay every lap.
    const gap =
      previous === undefined
        ? next.atMs
        : next.atMs >= previous.atMs
          ? next.atMs - previous.atMs
          : Math.max(0, (steps[1]?.atMs ?? 0) - (steps[0]?.atMs ?? 0));
    const timer = setTimeout(() => {
      process.timer = null;
      if (!runStep(process)) return;
      schedule(process);
    }, gap / speed);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    process.timer = timer;
  }

  return {
    spawn(): FakeProcessHandle {
      spawns += 1;
      const process: FakeProcess = {
        stdout: new Set(),
        stderr: new Set(),
        exits: new Set(),
        established: false,
        capturing: false,
        index: 0,
        timer: null,
        dead: false,
      };
      current = process;

      return {
        onStdout(listener) {
          process.stdout.add(listener);
          return () => process.stdout.delete(listener);
        },
        onStderr(listener) {
          process.stderr.add(listener);
          return () => process.stderr.delete(listener);
        },
        onExit(listener) {
          process.exits.add(listener);
          return () => process.exits.delete(listener);
        },
        write(line: string) {
          // A write to a process that has exited is silently dropped, exactly as a closed pipe
          // would drop it. A throw here would be a failure mode real code cannot produce.
          if (process.dead) return;
          admit(process, line);
        },
        kill(): Promise<void> {
          die(process, 'killed by SIGTERM');
          return Promise.resolve();
        },
      };
    },

    step(): boolean {
      const process = current;
      if (process === null || process.dead || !process.capturing) return false;
      return runStep(process);
    },

    drain(): number {
      let count = 0;
      // Bounded by the script under `loop`, which would otherwise never be exhausted.
      const ceiling = opts.script.steps.length;
      while (count < ceiling && this.step()) count += 1;
      return count;
    },

    get remaining(): number {
      const process = current;
      if (process === null || process.dead) return 0;
      return Math.max(0, opts.script.steps.length - process.index);
    },

    get capturing(): boolean {
      return current?.capturing === true && !current.dead;
    },

    stats(): FakeVisionStats {
      return {
        spawns,
        commands: [...commands],
        undecodableCommands,
        captureConfig,
        handshakes,
      };
    },
  };
}

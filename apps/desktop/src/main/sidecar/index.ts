/**
 * `SidecarObservationSource` — the vision sidecar as an ordinary supervised source.
 *
 * `state-capture-architecture.md` §8's file list calls this `sidecar-source.ts` and puts it in
 * `main/state/`. It is here instead, in its own directory, for one reason: the process lifecycle
 * is the substantial part, `main/state/` is meant to be wiring with no domain logic in it, and a
 * child-process supervisor with backoff and a kill grace period is not wiring.
 *
 * The restart *policy* still belongs to `SourceSupervisor` — this source exposes `onExit` and lets
 * the supervisor decide when to try again, rather than holding a second backoff of its own. Two
 * restart loops for one process is the kind of thing that produces a fork bomb the first time both
 * fire.
 *
 * ⚠ **The binary it supervises cannot capture anything yet.** `crates/riki-vision` now speaks the
 * protocol, completes the handshake and runs the crop-and-hash pipeline, but every platform
 * backend reports itself unavailable (`riki_capture::platform`) — so on a real machine it starts,
 * says `ready` with `backendAvailable: false`, reports a `backend_unavailable` problem and then
 * sits there. It no longer exits immediately, and it no longer trips the restart backoff.
 *
 * `vision: 'off'` remains the shipping default in `ShellConfig`, for the narrower reason that a
 * sidecar which cannot capture has nothing to contribute. Turning it on is how the handshake gets
 * exercised against a real process.
 *
 * ✅ **`RIKI_FAKE_VISION=1` supervises a peer that can.** `@riki/protocol/testing`'s
 * `FakeVisionSidecar` is a `ChildProcessPort` that speaks the real protocol, so everything in this
 * file runs unchanged against a sidecar that reports hero positions, problems and panics. It is the
 * only configuration in which the vision → coaching edge executes today (ADR-0035), and
 * `apps/desktop/test/vision-coaching.test.ts` is where it is asserted end to end.
 */

import type { MonoMs, Observation, SourceHealth } from '@riki/world-model';
import type { ExitingSource } from '../state/index.js';
import type {
  ChildProcessHandle,
  ChildProcessPort,
  SidecarCodec,
  SidecarStats,
  SpawnRequest,
} from './contracts.js';

export * from './contracts.js';
export { KILL_GRACE_MS, createNodeChildProcessPort } from './node-process.js';
export {
  APP_IDENTITY,
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_CAPTURE_REGIONS,
  createProtocolCodec,
  type CvDetection,
  type CvDetectionsPayload,
  type ProtocolCodecDeps,
} from './protocol-codec.js';

/** A source is `degraded` rather than `down` while it has produced something recently. */
export const SIDECAR_QUIET_MS = 5_000;

export interface SidecarSourceDeps {
  readonly processes: ChildProcessPort;
  readonly request: SpawnRequest;
  readonly now: () => MonoMs;
  readonly codec?: SidecarCodec;
  readonly sourceId?: string;
  readonly onStderr?: (line: string) => void;
}

export interface SidecarSource extends ExitingSource {
  stats(): SidecarStats;
}

/**
 * A codec that understands nothing.
 *
 * Kept now that `protocol-codec.ts` exists, because the tests that care about *process*
 * behaviour — crash, backoff, chunk boundaries, a SIGTERM that is ignored — should not also have
 * to speak a wire format. The counter it feeds is the point: `linesUndecodable` rising while
 * `linesIn` rises is a sidecar that is talking and not being understood, which is a completely
 * different problem from a sidecar that is silent, and the two are indistinguishable without it.
 */
export const NULL_CODEC: SidecarCodec = {
  decode: () => ({ kind: 'undecodable' }),
  hello: () => [],
};

export function createSidecarSource(deps: SidecarSourceDeps): SidecarSource {
  const id = deps.sourceId ?? 'sidecar';
  const codec = deps.codec ?? NULL_CODEC;

  const listeners = new Set<(o: Observation) => void>();
  const exitListeners = new Set<(reason: string) => void>();

  let child: ChildProcessHandle | null = null;
  let detach: (() => void) | null = null;
  let seq = 0;
  let lastObservationAt: MonoMs | null = null;
  let startedAt: MonoMs | null = null;

  const stats = {
    spawns: 0,
    exits: 0,
    linesIn: 0,
    linesHandled: 0,
    linesUndecodable: 0,
    lastExitReason: null as string | null,
  };

  function teardown(): void {
    detach?.();
    detach = null;
    child = null;
  }

  function spawnChild(): void {
    if (child !== null) return;

    const handle = deps.processes.spawn(deps.request);
    child = handle;
    stats.spawns += 1;
    startedAt = deps.now();

    const stopStdout = handle.onStdout((line) => {
      stats.linesIn += 1;
      const at = deps.now();
      const decoded = codec.decode(line, at, seq);
      if (decoded.kind === 'undecodable') {
        stats.linesUndecodable += 1;
        return;
      }
      // A handshake reply is understood but is not a fact, so it must not move
      // `lastObservationAt` — a sidecar whose only output was `ready` is not `live`, and health
      // that said otherwise would hide exactly the failure this module exists to catch.
      if (decoded.kind === 'handled') {
        stats.linesHandled += 1;
        return;
      }
      seq += 1;
      lastObservationAt = at;
      for (const listener of [...listeners]) listener(decoded.observation);
    });

    const stopStderr = handle.onStderr((line) => {
      deps.onStderr?.(line);
    });

    const stopExit = handle.onExit((reason) => {
      stats.exits += 1;
      stats.lastExitReason = reason;
      teardown();
      for (const listener of [...exitListeners]) listener(reason);
    });

    detach = (): void => {
      stopStdout();
      stopStderr();
      stopExit();
    };

    for (const line of codec.hello()) handle.write(line);
  }

  return {
    id,

    /**
     * `spawn` is synchronous and the signature is a promise anyway, so the two have to be
     * reconciled somewhere.
     *
     * A `spawn` that throws — which is how a missing binary usually fails — must reach the caller
     * as a **rejection**, not as an exception thrown out of a call whose type says it returns a
     * promise. `SourceSupervisor` happens to catch either, because it awaits inside a `try`; no
     * other caller should have to know that.
     */
    start(): Promise<void> {
      try {
        spawnChild();
        return Promise.resolve();
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async stop(): Promise<void> {
      const handle = child;
      // Detach first: a `kill` that fires `onExit` must not look like a crash to the supervisor,
      // which would schedule a restart of something we are shutting down.
      teardown();
      startedAt = null;
      if (handle !== null) await handle.kill();
    },

    subscribe(listener: (o: Observation) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onExit(listener: (reason: string) => void): () => void {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },

    health(now: MonoMs): SourceHealth {
      if (child === null) {
        return {
          state: 'down',
          lastObservationAt,
          ...(stats.lastExitReason === null ? {} : { reason: stats.lastExitReason }),
        };
      }
      if (lastObservationAt === null) {
        // Spawned and not yet talking. `starting` until it has had long enough to say something,
        // then `degraded` — a running process that never speaks is a real failure and must not sit
        // in `starting` forever looking like a slow boot.
        const waited = startedAt === null ? 0 : now - startedAt;
        return waited < SIDECAR_QUIET_MS
          ? { state: 'starting', lastObservationAt: null }
          : { state: 'degraded', lastObservationAt: null, reason: 'no detections yet' };
      }
      return now - lastObservationAt < SIDECAR_QUIET_MS
        ? { state: 'live', lastObservationAt }
        : { state: 'degraded', lastObservationAt, reason: 'no recent detections' };
    },

    stats(): SidecarStats {
      return { ...stats };
    },
  };
}
